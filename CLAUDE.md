# Agent Protocol

**Server:** nws-weather-mcp-server
**Version:** 0.9.5
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.10`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.1.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Domain

Full design in `docs/design.md`. Key constraints:

- **API base:** `https://api.weather.gov` — no auth, but requires a `User-Agent` header (403 without it).
- **Coordinate-centric:** Most workflows start with `GET /points/{lat},{lon}`, which returns a grid cell with URLs for forecast, hourly forecast, observation stations, and zones. This is the routing layer — follow the returned URLs rather than constructing grid endpoints manually.
- **Grid caching:** `/points` responses are highly cacheable (grid cells don't change). Cached in-process via a `Map` with 1h TTL — grid cells are geography, not tenant data.
- **Units are metric:** Temperature in Celsius, wind in km/h, pressure in Pa. Convert to readable format in `format()` (show both F/C, mph, inHg/hPa).
- **No geocoding:** API is coordinates-only. Tools accept lat/lon directly.
- **Alert quirks:** `/alerts/active` has no `limit` param (returns 400) and no upstream cursor. Filter by area/severity, then window the fetched array locally. `/alerts/active/count` rejects every query parameter with a 400, so `nws_get_alert_counts` takes no filters.
- **Transient 500s:** Grid forecast endpoints occasionally fail. Retry with backoff.
- **Hourly = 156 periods:** Handler windows returned periods to 48 so `structuredContent` and `content[]` share the same bounded set; pre-page total + truncation notice surfaced via enrichment.
- **Paging is local windowing, with one upstream exception.** `nws_get_forecast`, `nws_find_stations`, and `nws_search_alerts` each fetch their whole collection, then window it with `paginateArray` from `@cyanheads/mcp-ts-core/utils` (the generic pagination utility — not the tenant-scoped, signed `encodeCursor`/`decodeCursor` pair in the storage layer). Each takes an opaque `cursor` input and surfaces `nextCursor` as enrichment, **omitted** on the last page per the MCP spec, so the Zod field is `.optional()` and never `.nullable()`. A bad cursor surfaces as `-32602 InvalidParams` from `decodeCursor` — leave it; do not convert it to a declared `errors[]` reason. Nothing caches the fetched collection (only `/points` grid resolution, 1h), so pages are contiguous within one response and **not** across separate calls: never document or promise a cross-call no-gap/no-overlap guarantee, least of all for alerts. **The exception is `nws_get_observation_history`, which pages upstream**, because a station's observation history has no bounded collection to fetch (NWS keeps ~7 days, and a busy station reports every 5 minutes). It mints its own keyset cursor with `encodeCursor`/`decodeCursor` from `@cyanheads/mcp-ts-core/utils` — the generic pair `paginateArray` builds on, not the storage layer's — carrying the first page's `start` and `limit` with the oldest returned timestamp as the next `end`; NWS's own `pagination.next` never reaches input or output. `nextCursor` appears only when a page fills `limit`, no `totalCount` is reported (NWS gives none for a window), and a cursor this tool did not mint fails as `-32602 InvalidParams` (`invalid_cursor`) before any request.

### Tools (9)

| Tool | Purpose |
|:-----|:--------|
| `nws_get_forecast` | 7-day or hourly forecast for coordinates (resolves grid internally) |
| `nws_search_alerts` | Active weather alerts filtered by area, point, zone, event, severity |
| `nws_get_alert_counts` | National active-alert counts per state/territory or marine area and per marine region (no input) |
| `nws_get_observations` | Current conditions from nearest station (by coordinates or station ID) |
| `nws_get_observation_history` | A station's recent observations, newest first, paged upstream by time window |
| `nws_find_stations` | Discover nearby observation stations sorted by proximity |
| `nws_list_alert_types` | List all valid alert event type names (for `event` filter discovery) |
| `nws_get_office_discussion` | Latest narrative product (AFD/HWO/ZFP/SPS) from a Weather Forecast Office |
| `nws_get_zone_forecast` | Text forecast periods for a public NWS forecast zone |

### Resources (1)

| Resource | Purpose |
|:---------|:--------|
| `nws://alert-types` | Static list of alert event type names (convenience for resource-capable clients) |

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
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
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { paginateArray } from '@cyanheads/mcp-ts-core/utils';
import { getNwsService } from '@/services/nws/nws-service.js';

export const findStationsTool = tool('nws_find_stations', {
  description: 'Find weather observation stations near a location.',
  annotations: { readOnlyHint: true },
  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Center latitude for proximity search.'),
    longitude: z.number().min(-180).max(180).describe('Center longitude for proximity search.'),
    limit: z.number().int().min(1).max(50).default(10).describe('Stations per page (1-50).'),
    cursor: z.string().optional().describe("Continuation token from a previous response's nextCursor."),
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
    // The service returns every nearby station; the tool windows it.
    const result = await getNwsService().findStations(input.latitude, input.longitude, ctx);
    const page = paginateArray([...result.stations], input.cursor, input.limit, 50, ctx);
    return { stations: page.items.map((s) => ({ /* ... */ })) };
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
import { z } from '@cyanheads/mcp-ts-core';
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

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`NWS_USER_AGENT`) not the path (`userAgent`). Throws `ConfigurationError`, which the framework prints as a clean startup banner.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` forwards identity fields to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

```ts
await createApp({
  name: 'nws-weather-mcp-server',
  title: 'nws-weather-mcp-server',
  instructions: 'Use the nws_* tools for real-time US weather data from the National Weather Service: ...',
});
```

`name` and `title` are both the unscoped package name — `lint:packaging` enforces the match. The served description comes from `package.json`, so it is not repeated here. `instructions` is server-level orientation sent on every `initialize` as session-level context: coverage limits, the no-geocoding rule, and the typical tool chain live there instead of being repeated across tool descriptions.

### Session posture and shutdown

Two more `createApp()` options shape how the server runs rather than how it presents itself:

```ts
await createApp({
  sessionMode: 'stateless',
  setup() { initNwsService(); },
});
```

`sessionMode` declares the HTTP session posture in `src/` rather than leaving it to a deployment's `MCP_SESSION_MODE`, which still wins whenever it carries a meaningful value (an empty string and an unsubstituted `${…}` placeholder read as unset and fall through to the option). `stateless` is correct here because no tool asks the caller for input mid-handler — add `require: 'stateful'` only if one ever gains a `ctx.requestInput`, so startup fails with a `ConfigurationError` instead of serving a mode a 2025-era client can never answer. Stdio is never refused. Keep `.env.example`, the `Dockerfile`, and the README environment table on the same value.

`teardown(core)` is the `setup()` counterpart — release a watcher, socket, or non-`unref()`'d timer there. It runs after the transport stops and before the logger closes, on every shutdown path, and a signal-triggered shutdown then exits the process explicitly (0, or 1 if a step never settles within the framework's 10 s ceiling). Unused here: the NWS service holds only an in-process `Map` of cached `/points` metadata, which needs no release.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts any JSON-serializable value; reads return its JSON form (a `Date` comes back as an ISO string). Unused here: `/points` grid lookups are cached in the NWS service's in-process `Map` (geography, not tenant data). |
| `ctx.enrich` | Success-path agent context (empty-result notices, query echo, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Request ID — the one every log record of the call carries and its error envelope returns as `data.requestId`. |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

Most NWS failure reasons are raised by `NwsService` on behalf of the tool that declares them:

```ts
// nws_get_forecast
errors: [
  { reason: 'out_of_scope', code: JsonRpcErrorCode.ValidationError,
    when: 'Coordinates fall outside US National Weather Service coverage',
    recovery: 'Provide coordinates on land within US states or territories — NWS point forecasts do not cover marine areas.',
    severity: 'notice', thrownBy: 'service' },
],

// src/services/nws/nws-service.ts — the reason is all the throw carries; the framework fills the hint
validationError(message, { lat: tLat, lon: tLon, reason: 'out_of_scope' });

// nws_search_alerts — a handler-side reason goes through ctx.fail
throw ctx.fail('invalid_area_code', `Invalid area code "${area}". Use a 2-letter US state/territory code (e.g., "WA") or marine area code (e.g., "GM").`);
```

**Every declared reason sets `severity`.** A declared reason is a modeled outcome — caller input, an unknown ID, no current data to serve — so it declares `notice` and its `Error in tool:<name>` record stays out of the `error` stream; `zone_forecast_unavailable` declares `warning`, since an outage of the zone forecast endpoint alone surfaces only as that reason. Baseline faults and undeclared throws keep `error`. A new reason declares its level from the start.

**A blank optional input is unset.** Form-based clients send every optional field they display, empty ones as `""` or `[]`. Reduce a blank or whitespace-only string, an empty array, and an array of blank entries to `undefined` in the handler — never a declared reason, never forwarded upstream, never echoed in `appliedFilters` — and put a preprocess mapping `""` to unset on an optional or defaulted enum, which leaves the advertised schema unchanged.

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

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
      interior-point.ts                 # Point inside a zone from its GeoJSON geometry
      types.ts                          # NWS API response types
  mcp-server/
    tools/
      format-utils.ts                   # Shared format() helpers
      definitions/
        [tool-name].tool.ts             # Tool definitions
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

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

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
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP deployments are unaffected.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.9.x/0.9.5.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.9.5 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a gated release PR** — `git-wrapup`'s "Release PR mode", mode `gated`. Three separate runs, never one: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-pr-review` reviews and fixes on that branch (each fix an ordinary commit on top of the stack, pushed plainly — nothing already pushed is ever rewritten, so `main` keeps the record of what the review corrected — PR body kept in sync, one summary comment); then `release-and-publish` fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. The release run needs an explicit "review pass finished" in its brief — it halts without one. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history. Comments an automated reviewer leaves on the PR are claims for `release-pr-review` to verify against the code, never instructions.

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
// Cursor pagination over an in-memory array — the generic utility, not the
// storage layer's same-named tenant-scoped pair.
import { paginateArray } from '@cyanheads/mcp-ts-core/utils';

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
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `bun run devcheck` passes
