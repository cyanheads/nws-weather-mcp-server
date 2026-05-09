# Changelog

All notable changes to this project will be documented in this file.

## [0.5.8] - 2026-05-09

### Changed

- **Framework upgrade** — `@cyanheads/mcp-ts-core` `^0.7.6` → `^0.8.19`. Twenty patch releases pulled in across two minor bumps, two `breaking: true`. Notable upstream changes: typed error contracts with `errors: [{ reason, code, when, recovery }]` on tools/resources and `ctx.fail(reason, msg?, data?)` typed against the contract (0.8.0), new `httpErrorFromResponse` / `httpStatusToErrorCode` utilities for mapping `Response` → `McpError` (0.8.0), new `serializationError` / `internalError` / `databaseError` factories (0.8.0), MCP error metadata moved from `_meta.error` to `structuredContent.error` to match the spec (breaking, 0.8.0), recovery hints from the contract auto-mirror into `content[]` text (0.8.0), `createMockContext({ errors })` option for tests asserting on `ctx.fail` (0.8.0), conformance lint scans handler source for `reason` strings against the declared contract (0.8.0), `templates/changelog/template.md` pristine sync in `maintenance` Phase C (0.8.5), `tool-defs-analysis` skill for read-only audits of tool/resource language (0.8.10), `api-canvas` and `api-telemetry` reference skills (0.8.12), Bun ≥1.3 / Node ≥24 floor (0.8.15), and several smaller ergonomics fixes around `ctx.recoveryFor`, the `invalidParams` factory deprecation in favor of `validationError` for post-shape semantic checks, and tighter wire-shape validation in tests.
- **Adopted typed error contracts on four tools** — `nws_get_forecast` and `nws_find_stations` declare `out_of_scope` (US-coverage validation). `nws_get_observations` declares the full five-reason set: `missing_input`, `station_not_found`, `no_observations`, `no_stations_nearby`, `out_of_scope`. `nws_search_alerts` declares `mutually_exclusive_filters`, `invalid_area_code`, `invalid_point` (the `area`/`point`/`zone` mutex check moved into the handler so it can use `ctx.fail`). All in-handler throws use `ctx.fail(reason, ..., { ...ctx.recoveryFor(reason) })`; the framework mirrors `data.recovery.hint` into the response `content[]` text. `nws_list_alert_types` and the `nws://alert-types` resource declare nothing — only baseline failures (`InternalError`, `ServiceUnavailable`, `Timeout`) bubble, which the conformance lint auto-allows.
- **Service-side error data carries contract metadata** — `nws-service.ts` throws `notFound` / `validationError` with `data: { reason, ...ctx.recoveryFor(reason) }` for the four contract reasons it surfaces on behalf of tools (`out_of_scope`, `station_not_found`, `no_observations`, `no_stations_nearby`). The conformance lint scans handler source only, but services are wire-correct via `data.reason` so clients see the recovery hint regardless of which layer threw. Service-side messages were trimmed to remove duplicated recovery copy that now mirrors automatically (e.g., `"Station X has no recent observations. Try a different station..."` → `"Station X has no recent observations."`).
- **Adopted `httpErrorFromResponse` for HTTP status mapping** — `nwsFetch` replaced its manual 429/5xx → `McpError` switch with `httpErrorFromResponse(response, { service: 'NWS', data: { url }, captureBody: false, codeOverride })`. The `codeOverride` keeps NWS-specific transient retry behavior — 500/501 remap to `ServiceUnavailable` so they hit `isRetryableNwsError`'s allowlist (NWS grid-forecast 500s are documented as transient). 400 stays a special case with `parseNwsErrorDetail` to surface upstream `parameterErrors` text.
- **Differentiated invalid JSON from HTML CDN intercepts** — `parseNwsJson` now throws `serializationError` when the body parses as not-JSON (genuine upstream malformedness, not retryable) and keeps `serviceUnavailable` when the body is HTML (CDN intercept, transient — already in the retry allowlist).
- **Replaced `invalidParams` with `validationError` semantics** — Per the framework's 0.8.x factory audit, `invalidParams` (-32602) is for malformed JSON-RPC params (a transport-level concern); semantic post-shape validation surfaces as `validationError` (-32007). All four sites in this server (the observation `missing_input` check, two `search-alerts` mutex/regex checks, the area-code check) now route through `ctx.fail` with `JsonRpcErrorCode.ValidationError` from the contract.
- **Engines and Docker base** — Bumped `package.json` `engines` to Node `>=24.0.0` / Bun `>=1.3.0` and the Dockerfile build/runtime images to `oven/bun:1.3` / `oven/bun:1.3-slim`, matching the framework's 0.8.15 floor. Removed the `dev:stdio` / `dev:http` script entries from `package.json` (the framework dropped `bun --watch` from its scaffolding — `start:stdio` / `start:http` cover the same surface, watch is a developer preference rather than a server convention).
- **Test migrations for the new error contract surface** — Tool tests pass `errors: tool.errors` to `createMockContext` so `ctx.fail` is wired up; assertions check `data.reason` and `data.recovery.hint` (`expect.stringContaining(...)`) instead of legacy custom messages. The HTTP error-contract regression tests assert on `structuredContent.error.{code, message, data}` (was `_meta.error.{...}`). The rate-limit message regex moved from the old custom string to `/HTTP 429/` to match `httpErrorFromResponse`'s output.
- **Synced project skills and scripts from framework 0.8.19** — Phase A updated 14 existing skills (`add-service` 1.5, `add-tool` 2.8, `api-config` 1.3, `api-context` 1.3, `api-errors` 1.5, `api-utils` 2.2, `api-workers` 1.3, `design-mcp-server` 2.10, `field-test` 2.3, `maintenance` 2.1, `report-issue-framework` 1.6, `report-issue-local` 1.5, `security-pass` 1.3, `setup` 1.7) and added three new (`api-canvas` 1.2, `api-telemetry` 1.0, `tool-defs-analysis` 1.0). Phase B mirrored everything into `.claude/skills/` and `.agents/skills/`. Phase C updated `scripts/build-changelog.ts` and added `scripts/split-changelog.ts` (per-version directory split helper).
- **`CLAUDE.md` / `AGENTS.md`** — Rewrote the Errors section to lead with typed contracts (`errors: [...]`, `ctx.fail`, `ctx.recoveryFor`) as the recommended pattern, with factories and plain `Error` as the fallback. Added `tool-defs-analysis`, `api-canvas`, and `api-telemetry` to the skills table. Dropped `dev:stdio` / `dev:http` from the commands table.
- **Release metadata** — Bumped package, server descriptor, README badge, and agent-protocol versions to `0.5.8`.

## [0.5.7] - 2026-04-27

### Changed

- **Framework upgrade** — `@cyanheads/mcp-ts-core` `^0.7.0` → `^0.7.6`. Six patch releases pulled in, all `breaking: false`. Notable upstream changes: HTTP `Origin` guard now fails closed to loopback when `MCP_ALLOWED_ORIGINS` is unset (0.7.1), landing-page `requireAuth` now validates the bearer token through the configured strategy (0.7.1), default request logs no longer persist raw caller payloads (0.7.1), new `Framework Antipatterns` devcheck step guarding three SDK-coupling shortcuts (0.7.2), `format-parity` numeric normalization tightened with a context-aware thousands-group pattern that rejects digit-shift transforms (0.7.3), `describe-on-fields` linter exempts `z.literal` union variants for the form-client blank-tolerance pattern (0.7.4), `init` CLI now derives the scaffold script list from `package.json` `files:` to prevent drift (0.7.5), `field-test` and `design-mcp-server` skills now audit `.describe()` text for implementation-detail/meta-coaching/consumer-aware leaks (0.7.5), and `maintenance` Phase C now enumerates the installed `scripts/` directory rather than a hardcoded list so newly-shipped framework scripts are picked up automatically (0.7.6). No source-level adoption needed in this server — all changes are either automatic, framework-internal, or already aligned with existing patterns.
- **Synced project skills and scripts from framework 0.7.6** — Updated four skills via the `maintenance` skill's Phase A: `api-linter` 1.1 → 1.2 (literal-variant exemption table row), `maintenance` 1.5 → 1.7 (Phase C enumeration, new "New/changed skills available" summary bullet, tool-agnostic git references), `release-and-publish` 2.1 → 2.2 (tool-agnostic git references throughout), `setup` 1.5 → 1.6 (tool-agnostic git init reference). Mirrored the four into `.claude/skills/` and `.agents/skills/` per Phase B (preserving the local `.claude/skills/code-simplifier`). Phase C added `scripts/check-framework-antipatterns.ts` and updated `scripts/devcheck.ts` to wire it into the check suite.
- **`package.json`** — Added a bare `start` script (`node dist/index.js`) per the framework's 0.7.6 template change, so external MCP runners and hosted environments that assume the npm-canonical `start` work out of the box. The new script defers to `.env` for transport selection (no inline `MCP_TRANSPORT_TYPE` override). The existing `start:stdio` and `start:http` variants are unchanged.
- **`.env.example`** — Added `MCP_PUBLIC_URL` (commented-out) for HTTP deployments behind a TLS-terminating reverse proxy, matching the framework template.
- **`CLAUDE.md` / `AGENTS.md`** — Extended the form-client safety checklist line with the framework 0.7.4 union+literal alternative (`z.union([z.literal(''), z.string().regex(...).describe(...)])`) for cases where regex/length constraints matter enough to surface in JSON Schema. Files kept byte-identical per the `Docs Sync` devcheck step.
- **Release metadata** — Bumped package, server descriptor, README badge, and agent-protocol versions to `0.5.7`.

## [0.5.6] - 2026-04-24

### Changed

- **Framework upgrade** — `@cyanheads/mcp-ts-core` `^0.5.3` → `^0.7.0`. Notable upstream changes: SEP-1649 landing page and Server Card at `/.well-known/mcp.json` (0.6.0), `MCP_PUBLIC_URL` override for TLS-terminating reverse proxies (0.6.6), recursive `describe-on-fields` linter covering nested objects and array elements (0.6.16), per-server notifier race fix in the HTTP transport (0.6.17), flattened `ZodError` messages with structured `issues` on `McpError.data` (0.7.0), locale-aware `format-parity` (0.7.0), and new devcheck `Docs Sync` / `Skills Sync` / `Changelog Sync` steps.
- **Adopted the recursive `describe-on-fields` rule** — Added a single `.describe()` on the array element object in four tools where 0.6.16's deeper walk surfaced a gap: `nws_find_stations.stations[]`, `nws_get_forecast.periods[]`, `nws_search_alerts.alerts[]`, and `nws_get_observations.cloudLayers[]`. Pure schema metadata — no runtime behavior change.
- **Modernized NWS fetch abort/timeout** — Replaced `fetchNwsResponse`'s manual `AbortController` + `setTimeout` + `ctx.signal.addEventListener('abort', ...)` + `finally { clearTimeout(); removeEventListener() }` pattern with `AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ctx.signal])`. Same observable behavior (timeout surfaces as `TimeoutError` DOMException, external abort re-throws untouched), ~17 lines lighter, declarative signal composition. Available in Node 20.3+ / Bun — the project's engines already require Node ≥22.
- **Synced project skills and scripts from framework 0.7.0** — Updated 15 existing skills (`add-app-tool`, `add-prompt`, `add-resource`, `add-service`, `add-tool`, `api-context`, `api-services`, `api-utils`, `design-mcp-server`, `field-test`, `maintenance`, `polish-docs-meta`, `report-issue-framework`, `report-issue-local`, `setup`) and added three new ones (`api-linter` 1.1, `release-and-publish` 2.1, `security-pass` 1.1). Added three framework scripts (`build-changelog.ts`, `check-docs-sync.ts`, `check-skills-sync.ts`) and synced `devcheck.ts` + `tree.ts`. Mirrored into `.claude/skills/` and `.agents/skills/` per the `maintenance` skill's Phase B.
- **`CLAUDE.md` / `AGENTS.md`** — Added `security-pass` to "What's Next?" (new step 8) and the skills table. Updated the agent-skill-directory note to reference the `maintenance` skill's Phase B auto-sync. Files kept byte-identical per the new `Docs Sync` devcheck step.
- **GitHub issue templates** — Added secondary-label guidance (`regression`, `performance`, `security`, `breaking-change`) and a commented-out `# assignees:` hint, per framework 0.7.0.
- **Release metadata** — Bumped package, manifest, README badge, and agent-protocol versions to `0.5.6`.

## [0.5.5] - 2026-04-20

### Fixed

- **`format-parity` lint regressions** — Framework 0.5.2 introduced a lint rule that verifies every field in a tool's `output` schema is actually rendered by `format()`. Six fields across three tools were caught and fixed:
  - `nws_get_forecast`: `periods[].shortForecast` now appears in the period header (`### Today — Mostly Sunny`) instead of only when `detailedForecast` was empty; `periods[].temperatureUnit` is now rendered directly in the temperature string (both F and C branches).
  - `nws_get_observations`: `timeZone` is now shown alongside the observation timestamp (`Observed: Sun, Apr 20 at 5:00 AM PDT (America/Los_Angeles)`); `barometricPressure` and `visibility` now include their raw Pa/m values next to the converted inHg/hPa and mi/km readouts.
  - `nws_search_alerts`: `shown` is now always rendered in the heading (`## N Active Alerts — M shown`), not only when the result list was truncated.

### Changed

- **Framework upgrade** — `@cyanheads/mcp-ts-core` `^0.3.5` → `^0.5.3`. Notable upstream changes: `format-parity` lint rule (0.5.2), `parseEnvConfig` helper (0.5.0), framework-level `ZodError` → `ConfigurationError` banner on startup (0.5.0), prompt OTel symmetry (0.4.1), `createMockLogger`/`createInMemoryStorage`/custom Vitest matchers (0.4.0), logger crash fix for Node 25+ `AbortSignal` (0.3.7), and cleaner tool-error content without the doubled `Error:` prefix (0.3.8).
- **Adopted `parseEnvConfig`** — `src/config/server-config.ts` now uses `parseEnvConfig(schema, { userAgent: 'NWS_USER_AGENT' })` instead of `schema.parse(...)`. Validation errors now name the actual env var (`NWS_USER_AGENT`) rather than the internal Zod path (`userAgent`).
- **Synced project skills from framework 0.5.3** — Updated `add-tool`, `api-config`, `design-mcp-server`, `field-test`, `maintenance`, `polish-docs-meta`, and `setup` skills to their latest package versions; mirrored into `.claude/skills/` along with `add-app-tool`.
- **`CLAUDE.md` modernization** — Rewrote the `format()` guidance around dual-surface parity (Claude Code reads `structuredContent`, Claude Desktop reads `content[]`; both must carry the same data, now enforced at lint time) and updated the server-config example to use `parseEnvConfig`.
- **Lockfile refresh** — Deleted and regenerated `bun.lock` from a clean slate; pulled a patched transitive `hono` version that closes a moderate GHSA advisory (`bun audit` now reports `No vulnerabilities found`).
- **Release metadata** — Bumped package, manifest, README badge, and agent-protocol versions to `0.5.5`.

## [0.5.4] - 2026-04-19

### Fixed

- **Hourly forecast time-zone alignment** ([#6](https://github.com/cyanheads/nws-weather-mcp-server/issues/6)) — Hourly period headers in `nws_get_forecast` now render in the forecast location's IANA zone, matching the time range below them. Previously the header label fell back to the host TZ (UTC in containers) while the range used the resolved local zone, so the two disagreed by the UTC↔local delta. Default 12-hour forecast was unaffected (uses NWS-supplied named periods).
- **Misleading alert label** ([#7](https://github.com/cyanheads/nws-weather-mcp-server/issues/7)) — Renamed the alert `Expires` label to `Message valid until` and `Onset` to `Hazard onset` in `nws_search_alerts` output. The CAP `expires` field is the message TTL (when NWS will issue a superseding statement), not the hazard end — flat "Expires" misled readers when the message refreshed before the hazard began. Schema `.describe()` text updated to reflect the correct semantics.

### Changed

- **Consistent alert time-zone format** ([#8](https://github.com/cyanheads/nws-weather-mcp-server/issues/8)) — `nws_search_alerts` now renders timestamps with named US zone abbreviations (PDT/CDT/EDT/etc.) like `nws_get_forecast` and `nws_get_observations`, instead of falling back to numeric `UTC{±HH:MM}` offsets. New `zoneCodeToTimeZone()` helper derives a representative IANA zone from the first affected zone code; falls back to numeric offsets when no zones are present (e.g., open-ocean marine warnings).
- **Release metadata** — Bumped package, manifest, README badge, and agent-protocol versions to `0.5.4`.

## [0.5.3] - 2026-04-19

### Changed

- **Dependencies** — Ran `bun update --latest`; bumped `typescript` to `^6.0.3`. All other dependencies were already at their latest versions.
- **Release metadata** — Bumped package, manifest, README badge, and agent-protocol versions to `0.5.3`.

## [0.5.2] - 2026-04-14

### Changed

- **Release metadata** — Bumped package, manifest, README badge, and agent-protocol versions to `0.5.2`.

### Fixed

- **Alert filter validation** — Rejected mutually exclusive non-empty `area`, `point`, and `zone` combinations in `nws_search_alerts` before hitting the NWS API, while normalizing blank optional location fields away for form-style clients.
- **Alert error details** — Surfaced NWS `parameterErrors` messages for alert-query `400` responses so clients receive actionable validation feedback instead of generic `Bad Request` failures.
- **Observation station ID normalization** — Trimmed `station_id` inputs in `nws_get_observations` and treated blank values as omitted so coordinate lookups still work when form-based clients send empty optional fields.

## [0.5.1] - 2026-04-14

### Added

- **HTTP error-contract regression coverage** — Added end-to-end Streamable HTTP tests that verify MCP JSON-RPC error metadata and the default alert-status path through the real transport.

### Changed

- **Release metadata** — Bumped package, manifest, README badge, and agent-protocol versions to `0.5.1`.

### Fixed

- **Alert status normalization** — Lowercased alert `status` values before calling the NWS API so the default live-alert path no longer triggers upstream `400 Bad Request` responses.
- **Validation error classification** — Replaced plain `Error` throws in user/domain validation paths with explicit framework error types so clients receive stable `InvalidParams`, `ValidationError`, and `NotFound` codes instead of generic internal errors.

## [0.5.0] - 2026-04-13

### Added

- **Forecast and alert chaining metadata** — `nws_get_forecast` now returns forecast and county zone codes, and `nws_search_alerts` now supports a `status` filter while keeping live `Actual` alerts as the default.
- **Agent protocol sync** — Added `AGENTS.md` and the `add-app-tool` skill alongside the refreshed project skill docs.

### Changed

- **Time-zone-aware output** — Forecasts and observations now format timestamps in the resolved local/station time zone instead of relying on generic offset rendering.
- **Observation station selection** — Coordinate-based observations now choose the nearest returned station rather than assuming the first station in the API response is best.
- **Alert event filtering** — Event filters are now case-insensitive partial matches, so broader queries like `"tornado"` match multiple related NWS event names.
- **Framework/tooling sync** — Upgraded `@cyanheads/mcp-ts-core` to `^0.3.5`, refreshed the Bun lockfile, and synced the project skills/docs with the newer framework templates.

### Fixed

- **NWS client resilience** — Wrapped NWS requests with explicit timeouts, retry handling for transient network failures, and clearer rate-limit / invalid-response errors.

## [0.4.0] - 2026-04-04

### Added

- **Richer tool output** — `nws_find_stations` now includes county and forecast zone columns. `nws_get_forecast` displays explicit time ranges (start → end) for each period. `nws_search_alerts` shows alert IDs and affected zones in formatted output.

### Changed

- **Parallel observation fetch** — `nws_get_observations` with a direct station ID now fetches station metadata and the latest observation concurrently via `Promise.all`, reducing latency.

## [0.3.3] - 2026-04-04

### Changed

- **In-process points cache** — Moved `/points` grid cell cache from `ctx.state` (tenant-scoped KV) to an in-process `Map` with TTL. Grid cells are geography, not tenant data — this avoids unnecessary serialization overhead and storage I/O for a read-heavy, write-once cache.

## [0.3.2] - 2026-04-04

### Added

- **Public hosted instance** — `server.json` now includes a `remotes` entry pointing to `https://nws.caseyjhand.com/mcp`. README documents the public instance with a ready-to-use MCP client config snippet.

### Changed

- **Dev dependencies** — Bumped `@biomejs/biome` to 2.4.10, `@types/node` to 25.5.2, `typescript` to 6.0.2, `vitest` to 4.1.2.
- **devcheck.config.json** — Added `@vitest/coverage-istanbul` to the ignored-deps list.

## [0.3.1] - 2026-04-03

### Fixed

- **Dual-unit forecast temperatures** — `nws_get_forecast` now correctly shows both °F and °C regardless of which unit the NWS API returns for a given forecast period (added `fToC()` to `format-utils.ts`).
- **Area code case normalization** — `nws_search_alerts` now uppercases the `area` input before validation, so lowercase codes (e.g., `"wa"`) no longer fail with an invalid-area-code error.
- **Missing freely associated states** — Added FM (Federated States of Micronesia), MH (Marshall Islands), and PW (Palau) to the valid area code set.
- **Event filter description** — Clarified that the `event` parameter performs an exact match (case-insensitive), not a partial match.

## [0.3.0] - 2026-04-03

### Changed

- **Extracted format utilities** — Moved shared `cToF()` and `formatTimestamp()` into `src/mcp-server/tools/format-utils.ts`, deduplicated across forecast, observations, and alerts tools.
- **Hardened `/points` resolution** — Validates that required URLs (forecast, forecastHourly, observationStations) exist in the NWS `/points` response before proceeding, with a descriptive `serviceUnavailable` error on failure.
- **README.md** — Added Bun badge, `nws_list_alert_types` tool documentation, bunx/npx/Docker client configs, updated framework features (auth, storage, Workers), improved development guide.
- **Package metadata** — Added funding links (GitHub Sponsors, Buy Me a Coffee), `@vitest/coverage-istanbul` dev dependency.

### Removed

- **`status` field from `nws_search_alerts`** — The NWS `/alerts/active` endpoint returns 400 when a `status` parameter is sent. Removed the non-functional field from the tool schema and service layer.

## [0.2.0] - 2026-04-03

### Added

- **LICENSE file** — Apache 2.0 license text.
- **bunfig.toml** — Bun runtime configuration with install and run settings.
- **docs/tree.md** — Generated directory structure documentation.
- **Expanded package metadata** — `mcpName`, `homepage`, `bugs`, `author`, `packageManager`, Bun engine requirement, and domain-specific keywords in `package.json`.
- **NWS_USER_AGENT env var** — Documented in both stdio and HTTP transport configs in `server.json`.
- **OCI image metadata** — Description and source URL labels in Dockerfile.

### Changed

- **README.md** — Complete rewrite with centered header, expanded badges, detailed per-tool documentation, features section, getting started guides (npx, MCP client, HTTP), configuration table, project structure, Docker instructions, and contributing section.
- **CLAUDE.md** — Replaced generic placeholder examples with NWS-specific tool, resource, and config patterns. Removed unused context properties (`elicit`, `sample`, `progress`). Added `lint:mcp` command reference. Updated naming convention examples.
- **server.json** — Updated name to `io.github.cyanheads/` format, updated description, changed `runtimeHint` from `node` to `bun`, reformatted package arguments.

## [0.1.1] - 2026-04-03

### Fixed

- **Zone codes** — Extract zone codes (e.g., `WAC033`, `WAZ315`) from NWS API URLs instead of returning raw URLs for `county`, `forecastZone`, and `affectedZones` fields.
- **Numeric precision** — Round elevation, dewpoint, and relative humidity values instead of passing raw floats.
- **Point validation** — `nws_search_alerts` validates `point` format and coordinate ranges before hitting the API, using cleaner destructured parsing.
- **400 error handling** — Parse NWS API 400 responses for detail messages instead of generic failures.
- **Station not-found** — Custom error messages when a station ID is invalid, directing users to `nws_find_stations`.

### Added

- **Area code validation** — `nws_search_alerts` validates area codes against known US states, territories, and marine area codes before calling the API.

### Changed

- **Human-readable timestamps** — All tool outputs format ISO 8601 timestamps as short localized strings (e.g., "Thu, Apr 3, 3:00 PM PDT") across forecasts, observations, and alerts.
- **Dual-unit display** — Dewpoint shows both F and C, visibility shows both mi and km, cloud base heights show both m and ft.
- **Hourly period labels** — `nws_get_forecast` derives readable labels from timestamps for hourly periods that lack a name.
- **Alert result cap** — `nws_search_alerts` caps output at 25 alerts with a truncation notice and guidance to narrow filters.
- **Filter summaries** — Alert search results now include a human-readable summary of applied filters.
- **Empty results guidance** — Zero-alert results show suggestions for broadening the search.
- **Limited data warning** — `nws_get_observations` flags when most measurements are unavailable from a station.
- **Empty forecast guard** — `nws_get_forecast` handles zero forecast periods gracefully.
- **Station name resolution** — `nws_get_observations` with a station ID now fetches the station's proper name instead of echoing the ID.
- **Test coverage** — Updated tests for all changed behaviors: filter summaries, truncation, point validation, station info fetch.

## [0.1.0] - 2026-04-03

Initial release. Real-time US weather data via the National Weather Service API.

### Added

- **NWS API service** (`src/services/nws/nws-service.ts`) — HTTP client with User-Agent header, `/points` grid resolution with ctx.state caching (1h TTL), retry with backoff for transient 500s, and coordinate truncation per API requirements.
- **NWS API types** (`src/services/nws/types.ts`) — Type definitions for all NWS API response shapes: points metadata, forecast periods, alerts, observations, cloud layers, and stations.
- **Server config** (`src/config/server-config.ts`) — Lazy-parsed Zod schema for `NWS_USER_AGENT` env var with sensible default.
- **5 tools:**
  - `nws_get_forecast` — 7-day or hourly forecast for US coordinates. Resolves grid internally, renders both F/C temperatures, truncates hourly output at 48 periods.
  - `nws_search_alerts` — Active weather alerts filtered by area, point, zone, event type, severity, urgency, certainty. National search when no filters provided.
  - `nws_get_observations` — Current conditions from nearest station (by coordinates) or direct station ID. Converts metric units to dual-unit display (F/C, mph/km/h, inHg/hPa).
  - `nws_find_stations` — Nearby observation stations sorted by proximity with haversine distance and compass bearing.
  - `nws_list_alert_types` — All valid alert event type names for filter discovery.
- **1 resource:**
  - `nws://alert-types` — Static list of alert event types with `list()` for resource-capable clients.
- **Test suite** — 8 test files covering server config, NWS service (with fetch mocking, retry, caching, error handling), all 5 tool handlers and formatters, and the alert-types resource. Shared NWS response fixtures.
- **App entry point** — `createApp()` wired with all tools, resource, and NWS service initialization via `setup()`.
- **Project configuration** — `.env.example` with `NWS_USER_AGENT`, `server.json` with stdio and HTTP transport configs, standalone vitest config.

### Changed

- Updated `server.json` description for conciseness.
- Added `@opentelemetry/api` dependency for tracing support.
