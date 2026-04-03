# Changelog

All notable changes to this project will be documented in this file.

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
