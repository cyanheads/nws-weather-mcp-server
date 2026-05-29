# Agent Protocol

**Server:** nws-weather-mcp-server
**Version:** 0.5.12
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Domain

Full design in `docs/design.md`. Key constraints:

- **API base:** `https://api.weather.gov` — no auth, but requires a `User-Agent` header (403 without it).
- **Coordinate-centric:** Most workflows start with `GET /points/{lat},{lon}`, which returns a grid cell with URLs for forecast, hourly forecast, observation stations, and zones. This is the routing layer — follow the returned URLs rather than constructing grid endpoints manually.
- **Grid caching:** `/points` responses are highly cacheable (grid cells don't change). Cached in-process via a `Map` with 1h TTL — grid cells are geography, not tenant data.
- **Units are metric:** Temperature in Celsius, wind in km/h, pressure in Pa. Convert to readable format in `format()` (show both F/C, mph, inHg/hPa).
- **No geocoding:** API is coordinates-only. Tools accept lat/lon directly.
- **Alert quirks:** `/alerts/active` has no `limit` param (returns 400). Filter by area/severity instead.
- **Transient 500s:** Grid forecast endpoints occasionally fail. Retry with backoff.
- **Hourly = 156 periods:** Truncate in `format()` to avoid flooding context (next 24-48h, note remainder).

### Tools (5)

| Tool | Purpose |
|:-----|:--------|
| `nws_get_forecast` | 7-day or hourly forecast for coordinates (resolves grid internally) |
| `nws_search_alerts` | Active weather alerts filtered by area, point, zone, event, severity |
| `nws_get_observations` | Current conditions from nearest station (by coordinates or station ID) |
| `nws_find_stations` | Discover nearby observation stations sorted by proximity |
| `nws_list_alert_types` | List all valid alert event type names (for `event` filter discovery) |

### Resources (1)

| Resource | Purpose |
|:---------|:--------|
| `nws://alert-types` | Static list of alert event type names (convenience for resource-capable clients) |

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, and `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNwsService } from '@/services/nws/nws-service.js';

export const findStationsTool = tool('nws_find_stations', {
  description: 'Find weather observation stations near a location.',
  annotations: { readOnlyHint: true },
  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Center latitude for proximity search.'),
    longitude: z.number().min(-180).max(180).describe('Center longitude for proximity search.'),
    limit: z.number().int().min(1).max(50).default(10).describe('Max stations to return (1-50).'),
  }),
  output: z.object({
    stations: z.array(z.object({
      stationId: z.string().describe('Station identifier (e.g., "KSEA")'),
      name: z.string().describe('Station name'),
      distance: z.number().describe('Distance from query point in km'),
      bearing: z.string().describe('Compass bearing from query point'),
    })).describe('Nearby stations sorted by distance'),
  }),

  async handler(input, ctx) {
    const result = await getNwsService().findStations(input.latitude, input.longitude, input.limit, ctx);
    return { stations: result.stations.map((s) => ({ /* ... */ })) };
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // Enforced at lint time: every field in `output` must appear in the rendered text.
  format: (result) => {
    const lines = [`## ${result.stations.length} Nearby Stations\n`];
    lines.push('| Station | Name | Distance | Bearing |');
    lines.push('|:--------|:-----|:---------|:--------|');
    for (const s of result.stations) {
      lines.push(`| ${s.stationId} | ${s.name} | ${s.distance} km | ${s.bearing} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
```

### Resource

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { getNwsService } from '@/services/nws/nws-service.js';

export const alertTypesResource = resource('nws://alert-types', {
  name: 'NWS Alert Event Types',
  description: 'Static list of all valid NWS alert event type names.',
  mimeType: 'application/json',
  params: z.object({}),

  async handler(_params, ctx) {
    const types = await getNwsService().listAlertTypes(ctx);
    return { count: types.length, eventTypes: [...types].sort() };
  },

  list: async () => ({
    resources: [{
      uri: 'nws://alert-types',
      name: 'NWS Alert Event Types',
      description: 'All valid alert event type names for filtering.',
      mimeType: 'application/json',
    }],
  }),
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  userAgent: z
    .string()
    .default('(nws-weather-mcp-server, github.com/cyanheads/nws-weather-mcp-server)')
    .describe('User-Agent header for NWS API requests. Required by the API — 403 without it.'),
});
let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    userAgent: 'NWS_USER_AGENT',
  });
  return _config;
}
```

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Used for grid cell caching. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Tools that surface domain-specific failures declare `errors: [{ reason, code, when, recovery, retryable? }]`. The handler then receives `ctx.fail(reason, msg?, data?)` typed against the reason union (`ctx.fail('typo')` is a TS error). Spread `ctx.recoveryFor('reason')` to copy the contract's recovery hint onto the wire — the framework mirrors `data.recovery.hint` into `content[]` text. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely without declaration.

```ts
errors: [
  { reason: 'out_of_scope', code: JsonRpcErrorCode.ValidationError,
    when: 'Coordinates fall outside US National Weather Service coverage',
    recovery: 'Provide coordinates within US states, territories, or adjacent marine areas.' },
],
async handler(input, ctx) {
  if (badCoords(input)) throw ctx.fail('out_of_scope', undefined, { ...ctx.recoveryFor('out_of_scope') });
  // ...
}
```

In services that throw on behalf of contract-bearing tools, pass `data: { reason: 'X', ...ctx.recoveryFor('X') }` to error factories. The conformance lint scans handler source only — services are wire-correct via `data.reason` but not lint-enforced.

**Fallback (no contract entry fits):** factories or plain `Error`.

```ts
// Error factories — explicit code, concise
import { notFound, validationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

Use `validationError` for semantic post-shape validation (the wrong-field-shape kind is rare post-Zod); `invalidParams` is for malformed JSON-RPC params. See framework CLAUDE.md for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # Server-specific env vars (Zod schema)
  services/
    nws/
      nws-service.ts                    # NWS API client (init/accessor pattern)
      types.ts                          # NWS API response types
  mcp-server/
    tools/definitions/
      [tool-name].tool.ts               # Tool definitions
    resources/definitions/
      [resource-name].resource.ts       # Resource definitions
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `get-forecast.tool.ts` |
| Tool/resource/prompt names | snake_case | `nws_get_forecast` |
| Directories | kebab-case | `src/services/nws/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Get the weather forecast for a US location.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `tool-defs-analysis` | Read-only audit of tool/resource/prompt language: voice, leaks, defaults, recovery hints, sparsity |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run lint:mcp` | Validate MCP tool/resource definitions |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` source files |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync with `changelog/*.md` (run by devcheck) |
| `bun run test` | Run tests |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP deployments are unaffected.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges.** Drop these into the project README to give users one-click install paths. Fill in `<OWNER>` / `<REPO>` / `<PACKAGE_NAME>` and encode the per-server config:

| Client | Mechanism |
|:-------|:----------|
| Claude Desktop | Browser downloads the `.mcpb` from the latest GitHub Release; OS file handler routes it to Claude Desktop. |
| Cursor | Official `https://cursor.com/en/install-mcp` endpoint with base64 JSON config. |
| VS Code / Insiders | Official `vscode:mcp/install?...` deep link, wrapped in `https://vscode.dev/redirect?url=` so GitHub-rendered markdown doesn't strip the non-HTTP scheme. |

```bash
# Cursor: base64-encoded JSON
echo -n '{"command":"npx -y <PACKAGE_NAME>"}' | base64

# VS Code: URL-encoded JSON
node -p 'encodeURIComponent(JSON.stringify({name:"<PACKAGE_NAME>",command:"npx",args:["-y","<PACKAGE_NAME>"]}))'
```

---

## Publishing

After a version bump and final commit, publish to both npm and GHCR:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/nws-weather-mcp-server:<version> \
  -t ghcr.io/cyanheads/nws-weather-mcp-server:latest \
  --push .
```

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getNwsService } from '@/services/nws/nws-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data (enforced at lint time)
- [ ] NWS API wrap: raw/domain/output schemas reviewed against real upstream sparsity/nullability (many fields are null on incomplete observation reports)
- [ ] NWS API wrap: normalization and `format()` preserve uncertainty — do not fabricate facts from missing upstream data (a null temperature is not 0)
- [ ] NWS API wrap: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `bun run devcheck` passes
