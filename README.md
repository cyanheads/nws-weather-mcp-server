<div align="center">
  <h1>@cyanheads/nws-weather-mcp-server</h1>
  <p><b>Get US weather forecasts, active alerts, and current observations via the National Weather Service API. STDIO or Streamable HTTP.</b>
  <div>10 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.11.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/nws-weather-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/nws-weather-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/nws-weather-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Real-time US weather from the National Weather Service: forecasts, active alerts, current conditions, and forecaster discussions for any point in the 50 states and US territories, plus zone forecasts, coastal and marine alerts, and a week of station history. No API key required.

### Tools

| Tool | Description |
|:----------|:------------|
| `nws_get_forecast` | 7-day or hourly forecast for coordinates. Resolves NWS grid internally. |
| `nws_search_alerts` | Active weather alerts filtered by area, point, zone, event, severity, urgency, certainty, and status. |
| `nws_get_alert` | One alert message by ID, current or superseded (~7-day retention). |
| `nws_get_alert_counts` | Active alert counts nationwide, per state/territory or marine area, and per marine region. |
| `nws_get_observations` | Current conditions by coordinates (nearest station) or station ID. |
| `nws_get_observation_history` | A station's recent observations, newest first, paged back through the ~7 days NWS keeps. |
| `nws_find_stations` | Nearby observation stations sorted by distance with bearing. |
| `nws_list_alert_types` | All valid alert event type names for filter discovery. |
| `nws_get_office_discussion` | Latest narrative product (AFD, HWO, ZFP, SPS, FWF) from a Weather Forecast Office; a product too large to inline comes back as a section outline. |
| `nws_get_zone_forecast` | Text forecast periods for an NWS forecast zone. |

### Resources

| Resource | Description |
|:---------|:------------|
| `nws://alert-types` | Static list of all valid NWS alert event type names. |

Also reachable via the `nws_list_alert_types` tool, for MCP clients that don't support resources.

## Capability reference

### `nws_get_forecast` <sub>tool</sub>

- `latitude` + `longitude`; returns 14 named 12-hour periods (~7 days) by default, or with `hourly: true` one-hour periods with dewpoint and humidity, 48 per page of the ~156 upstream
- `nextCursor` carries its mode, so an hourly walk continues hourly without resending `hourly: true`
- `include_amounts: true` adds every native `quantitativePrecipitation`, `snowfallAmount`, and `iceAccumulation` interval as `precipitationAmounts` (`layer`, `uom`, `values` with `validTime` and `value`), plus the separate `amountsUpdateTime`. Default false; resend it on any cursor page that needs amounts. Interval strings, units, zeroes, and nulls stay unchanged. Missing layers and unavailable amounts are explained in `notice`; present empty layers carry `values: []`. Absent units or update time are null. An unavailable amount feed leaves the main forecast available.
- Returns `updateTime`, when the grid's forecast data was last updated, beside `generatedAt`; a `notice` flags a grid not updated in more than 24 hours
- Returns the `forecastZone` and `county` zone codes for chaining into `nws_search_alerts`
- Marine coordinates fail with `marine_forecast_unsupported`, and land points NWS serves no forecast grid for fail with `no_forecast_grid`

---

### `nws_search_alerts` <sub>tool</sub>

- At most one location filter (`area`, `point`, `zone`, `region_type`, or `region`), or none for a national search; `event` matches case-insensitively and partially; `status` defaults to `Actual` (also `Exercise`, `System`, `Test`, `Draft`)
- `limit` (default 25) is capped at 25; a larger limit is served as 25 and reported through `requestedLimit`/`effectiveLimit`
- `nextCursor` carries the query's filters and page size, so pass it back as `cursor` on its own; filters sent with it are ignored
- Each `affectedZones` entry carries its zone `type` (`forecast`/`county`/`fire`); `references` lists superseded messages newest first by `sent`; a `point` outside NWS coverage fails with `invalid_point`
- Each alert carries `office` (the issuing office code for `nws_get_office_discussion`, e.g. `RIW`), raw `vtec` strings, the `nwsHeadline`, and `hazard` tags such as `maxHailSize` and `maxWindGust`, verbatim

---

### `nws_get_alert` <sub>tool</sub>

- `alert_id`: an alert `id` from `nws_search_alerts`, or a `references[].identifier` from any alert; returns `{ alert }` in the same shape as `nws_search_alerts`, including superseded messages
- A malformed ID, an unknown one, and one past NWS's ~7-day retention all fail with `alert_not_found`

---

### `nws_get_alert_counts` <sub>tool</sub>

- No input; returns national `totalAlerts` (`landAlerts` + `marineAlerts`), plus `areas` counts keyed by state/territory or marine area code and `regions` counts keyed by marine region (`AL`, `AT`, `GL`, `GM`, `PA`, `PI`), each listing only codes with an active alert
- Counts cover every message status, Test and Exercise included, so `totalAlerts` can exceed a national `nws_search_alerts` `totalCount` (`status: Actual` by default); an alert counts once in each area its zones fall in, so `areas` can sum past `totalAlerts`

---

### `nws_get_observations` <sub>tool</sub>

- Look up by coordinates (resolves nearest station) or `station_id` directly
- Dual-unit display on every measurement (F/C, mph/km/h, inHg/hPa, mi/km, in/mm), temperatures to one decimal; 1-, 3-, and 6-hour precipitation amounts from hourly reports, with `0` a trace and `null` no amount reported; observations older than 2 hours carry a staleness notice, and a separate warning flags a station with most measurements unavailable

---

### `nws_get_observation_history` <sub>tool</sub>

- `station_id` (from `nws_find_stations`); optional `start` (inclusive) and `end` (exclusive) as ISO 8601 date-times with seconds and an offset; newest first, back through the ~7 days NWS keeps
- `limit` (default 24) is capped at 100; a larger limit is served as 100 and reported through `requestedLimit`/`effectiveLimit`
- Each observation carries the `nws_get_observations` measurement fields, `null` where the station reported nothing; an unknown station fails with `station_not_found`, and a malformed window or a `start` not before `end` with `invalid_time_window`
- `nextCursor` appears only when older observations remain; there is no `totalCount`, since NWS reports none for a window

---

### `nws_find_stations` <sub>tool</sub>

- `latitude` + `longitude`; optional `limit` (default 10) is capped at 50; a larger limit is served as 50 and reported through `requestedLimit`/`effectiveLimit`
- Nearest first; each result carries the station ID for `nws_get_observations`, distance (km), bearing, zone codes, elevation, and time zone

---

### `nws_list_alert_types` <sub>tool</sub>

- Returns the full set of event types the NWS API recognizes (e.g., "Tornado Warning", "Heat Advisory")
- Use to discover valid values for the `event` filter in `nws_search_alerts`

---

### `nws_get_office_discussion` <sub>tool</sub>

- `office`: usually the 3-letter WFO code (e.g., "SEW" for Seattle) returned as the `office` field by `nws_get_forecast`; `product_type`: `AFD` (default), `HWO`, `ZFP`, `SPS`, or `FWF` (Fire Weather Planning Forecast)
- Returns `productText` plus `issuanceTime`, `issuingOffice`, `productName`, `productCode`, `wmoCollectiveId`; `content[]` carries the product text in a `text` code block, so fixed-width tables keep their columns; an unknown office, or one with no current product of the requested type, fails with `no_products`
- A product too large to inline (most ZFPs and FWFs) returns an `outline` of its sections instead of `productText`; pass `sections` (AFD section names, or zone codes for ZFP/HWO/SPS/FWF) to get the matching sections, and an unknown name fails with `unknown_section`
- An alert zone typed `fire` gets its forecast from the FWF: `office` from the alert's `office` field, `product_type: "FWF"`, `sections: [<zone code>]`

---

### `nws_get_zone_forecast` <sub>tool</sub>

- `zone_id`: forecast zone code (e.g., "WAZ315") — returned by `nws_get_forecast` (`forecastZone`), `nws_find_stations` (`forecastZone` column), and `nws_search_alerts` (the `code` of an `affectedZones` entry with `type: "forecast"`)
- Returns named periods (e.g., "Today", "Tonight", "Monday") with narrative text from local forecasters
- County (`XXC###`) and unknown zone codes fail with `zone_not_found`, and so do most fire zone codes, whose forecast is their segment of the office FWF on `nws_get_office_discussion`; a fire code that is also a public zone code returns the public zone's forecast; marine zones with no text forecast fail with `marine_forecast_unsupported`, and land zones with none with `zone_forecast_unavailable`

---

### `nws://alert-types` <sub>resource</sub>

- Static list of all valid NWS alert event type names, returned as `application/json`
- No parameters; cached publicly for 1 hour

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

NWS-specific:

- Sends the required `User-Agent` header automatically (configurable via `NWS_USER_AGENT`) — NWS returns 403 without one
- Automatic coordinate-to-grid resolution via `/points`, cached for 1h since grid cells rarely change
- Request timeouts plus retry/backoff for transient NWS API failures
- Zero-auth access — no API keys required
- Paged results — pass the returned `nextCursor` back as `cursor` for the next page (omitted on the last page)

Agent-friendly output:

- Provenance — responses echo office codes, time zones, and zone codes so agents can chain into `nws_get_office_discussion`, `nws_get_zone_forecast`, and `nws_search_alerts`
- Guidance over silence — empty, truncated, or cursor-past-end results carry a `notice` naming the cause and the next step
- Typed error reasons (`invalid_area_code`, `no_products`, `zone_not_found`, …) so callers branch on data, not string parsing
- Dual-unit measurements (F/C, mph/km/h, inHg/hPa, mi/km, in/mm), rounded to match the text output

## Getting started

### Public Hosted Instance

A public instance is available at `https://nws.caseyjhand.com/mcp` — no installation required. It serves Streamable HTTP; each client takes its own config shape.

For Claude Code:

```sh
claude mcp add --transport http nws-weather-mcp-server https://nws.caseyjhand.com/mcp
```

For Cline (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "nws-weather-mcp-server": {
      "type": "streamableHttp",
      "url": "https://nws.caseyjhand.com/mcp"
    }
  }
}
```

For Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "nws-weather-mcp-server": {
      "url": "https://nws.caseyjhand.com/mcp"
    }
  }
}
```

Claude Desktop adds remote servers under Settings → Connectors.

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
