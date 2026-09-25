<div align="center">
  <h1>@cyanheads/nws-weather-mcp-server</h1>
  <p><b>Get US weather forecasts, active alerts, and current observations via the National Weather Service API. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.9.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/nws-weather-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/nws-weather-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/nws-weather-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/nws-weather-mcp-server/releases/latest/download/nws-weather-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=nws-weather-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbndzLXdlYXRoZXItbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22nws-weather-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnws-weather-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://nws.caseyjhand.com/mcp](https://nws.caseyjhand.com/mcp)

</div>

---

## Overview

US weather data from the National Weather Service API (`api.weather.gov`). Get forecasts, active alerts, current observations, forecast-office narrative products, and zone-level text forecasts for any coordinate in the 50 states and US territories. Adjacent marine areas are covered by alerts, plus stations and observations near the coast; NWS publishes no point or zone text forecast for them. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:----------|:------------|
| `nws_get_forecast` | 7-day or hourly forecast for coordinates. Resolves NWS grid internally. |
| `nws_search_alerts` | Active weather alerts filtered by area, point, zone, event, severity, urgency, certainty, and status. |
| `nws_get_observations` | Current conditions by coordinates (nearest station) or station ID. |
| `nws_find_stations` | Nearby observation stations sorted by distance with bearing. |
| `nws_list_alert_types` | All valid alert event type names for filter discovery. |
| `nws_get_office_discussion` | Latest narrative product (AFD, HWO, ZFP, SPS) from a Weather Forecast Office. |
| `nws_get_zone_forecast` | Text forecast periods for a public NWS forecast zone. |

### Resources

| Resource | Description |
|:---------|:------------|
| `nws://alert-types` | Static list of all valid NWS alert event type names. |

Also reachable via the `nws_list_alert_types` tool, for MCP clients that don't support resources.

## Capability reference

### `nws_get_forecast` <sub>tool</sub>

- Default returns named 12-hour periods (14 total, ~7 days)
- Hourly mode returns 48 one-hour periods per page with dewpoint and humidity — the upstream feed carries ~156, and the pre-page total (`totalCount`, against this page's `shown`) plus a truncation notice are surfaced in the enrichment block
- Pass the returned `nextCursor` back as `cursor` to reach the remaining periods; it is omitted on the last page
- Coordinates resolve to NWS grid internally via `/points`
- Formatted timestamps use the resolved local time zone
- Returns forecast zone and county zone codes for chaining into `nws_search_alerts`
- Marine coordinates fail with a typed `marine_forecast_unsupported` error — NWS publishes no point forecast for marine areas — pointing to a nearby land point or `nws_search_alerts`

---

### `nws_search_alerts` <sub>tool</sub>

- `area`, `point`, `zone`, `region_type`, and `region` are mutually exclusive location filters (at most one, or none for a national search); `event` matches case-insensitively and partially (`"tornado"` matches both watches and warnings); `status` defaults to `Actual` (also `Exercise`, `System`, `Test`, `Draft`)
- A blank string filter or an empty-array filter is rejected rather than silently widened to an unfiltered search
- Area/point/zone shape is validated locally before the API call, failing fast with typed `invalid_area_code` / `invalid_point` / `invalid_zone` reasons instead of a raw upstream 400
- `limit` (1-25, default 25) pages results; `totalCount` is the full distinct-alert count (duplicates collapsed on `id`) against `shown`, and `nextCursor` continues — pages are contiguous only within one response, since every call re-fetches the live feed
- Each `affectedZones` entry carries its zone `type` (`forecast`/`county`/`fire`) so callers know which codes chain into `nws_get_zone_forecast`
- CAP message-lifecycle fields (`sent`, `effective`, `status`, `messageType`, `references`) are distinct from the hazard's own `onset`/`ends`

---

### `nws_get_observations` <sub>tool</sub>

- Look up by coordinates (resolves nearest station) or `station_id` directly; a blank/whitespace-only `station_id` is rejected rather than silently falling back to coordinates
- Dual-unit display on every measurement: F/C, mph/km/h, inHg/hPa, mi/km
- Observation timestamps use the station's local time zone when known
- Flags observations older than 2 hours with a staleness notice, and warns separately when most measurements are unavailable from the station

---

### `nws_find_stations` <sub>tool</sub>

- Sorted by haversine distance from the query point; each result carries distance (km), bearing, zone codes, elevation, and time zone
- Optional `limit` (1-50, default 10) sizes the page; `totalCount` reports every station near the point and holds steady across pages, while `shown` is the size of this page
- Pass the returned `nextCursor` back as `cursor` to reach stations beyond the page; it is omitted on the last page
- Useful for finding station IDs for `nws_get_observations`

---

### `nws_list_alert_types` <sub>tool</sub>

- Returns the full set of event types the NWS API recognizes (e.g., "Tornado Warning", "Heat Advisory")
- Use to discover valid values for the `event` filter in `nws_search_alerts`

---

### `nws_get_office_discussion` <sub>tool</sub>

- `office`: 3-letter WFO code (e.g., "SEW" for Seattle) — returned as the `office` field by `nws_get_forecast`
- `product_type`: `AFD` (default, forecaster reasoning and model analysis), `HWO` (1-7 day hazard outlook), `ZFP` (zone-by-zone text forecast), `SPS` (short-fuse advisory)
- Returns `productText` plus `issuanceTime`, `issuingOffice`, `productName`, `productCode`, `wmoCollectiveId`
- An unknown office, or a valid office with no current product of the requested type, fails with a typed `no_products` error and recovery guidance — NWS answers HTTP 200 with an empty list rather than a 404

---

### `nws_get_zone_forecast` <sub>tool</sub>

- `zone_id`: forecast zone code (e.g., "WAZ315") — returned by `nws_get_forecast` (`forecastZone`), `nws_find_stations` (`forecastZone` column), and `nws_search_alerts` (the `code` of an `affectedZones` entry with `type: "forecast"`)
- Returns named periods (e.g., "Today", "Tonight", "Monday") with narrative text from local forecasters
- Completes the alert-to-forecast chain: look up alert zones, then retrieve zone forecasts
- County (`XXC###`) and fire zone codes are not supported here — NWS publishes no text forecast for them, though they remain valid values for the `zone` filter on `nws_search_alerts`; an unsupported or unknown zone fails with a typed `zone_not_found` error
- Marine forecast zones (e.g., `PZZ251`) fail with `marine_forecast_unsupported`; a valid zone NWS publishes no text forecast for fails with `zone_forecast_unavailable`, which points to `nws_get_forecast` for the zone's point forecast

---

### `nws://alert-types` <sub>resource</sub>

- Static list of all valid NWS alert event type names, returned as `application/json`
- Duplicates `nws_list_alert_types` for MCP clients that support resources rather than tools
- Cached publicly for 1 hour — NWS revises this vocabulary on the order of years
- No parameters

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

NWS-specific:

- Sends the required `User-Agent` header automatically (configurable via `NWS_USER_AGENT`) — NWS returns 403 without one
- Automatic coordinate-to-grid resolution via `/points`, cached for 1h since grid cells rarely change
- Request timeouts plus retry/backoff for transient NWS API failures
- Zero-auth access — no API keys required
- Dual-unit display for observations (F/C, mph/km/h, inHg/hPa, mi/km)

Agent-friendly output:

- Provenance — forecast, observation, and station responses echo office codes, time zones, and forecast/county zone codes so agents can chain directly into `nws_get_office_discussion`, `nws_get_zone_forecast`, and `nws_search_alerts` without re-deriving them
- Guidance over silence — empty, truncated, or cursor-past-end results carry a `notice` naming the cause and the concrete next step, rather than an empty array or a bare page
- Discriminated output contracts — zone `type` (`forecast`/`county`/`fire`), CAP `status`/`messageType` distinct from hazard `onset`/`ends`, and typed error reasons (`invalid_area_code`, `no_products`, `zone_not_found`, …) — callers branch on data, not string parsing
- Response shaping — upstream single-unit floats are normalized into dual-unit pairs (F/C, mph/km/h, inHg/hPa, mi/km) and rounded to match what `format()` renders, so structured and text output agree

## Getting started

### Public Hosted Instance

A public instance is available at `https://nws.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "nws-weather-mcp-server": {
      "type": "streamable-http",
      "url": "https://nws.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "nws-weather-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/nws-weather-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "nws-weather-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/nws-weather-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "nws-weather-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/nws-weather-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_SESSION_MODE=stateless MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Node.js v24+](https://nodejs.org/) or [Bun v1.4+](https://bun.sh/)

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/nws-weather-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd nws-weather-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `NWS_USER_AGENT` | User-Agent for NWS API requests. The API requires this header. | `(nws-weather-mcp-server, ...)` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_HTTP_HOST` | Hostname for HTTP server. | `127.0.0.1` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateful`, `stateless`, or `auto`. | `stateless` |
| `MCP_LOG_LEVEL` | Log level: `debug`, `info`, `notice`, `warning`, `error`. | `info` |

See [`.env.example`](.env.example) for the full list including auth, storage, and OpenTelemetry options.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck     # Lints, formats, type-checks
  bun run test         # Runs test suite
  ```

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and the resource. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/services/nws/` | NWS API client and response types. |
| `src/config/` | Environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for domain-specific logging, `ctx.state` for storage
- Add new tools/resources to the barrel exports and the `createApp()` arrays in `src/index.ts`
- Wrap NWS API calls: validate raw JSON → normalize to domain types → return the output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
