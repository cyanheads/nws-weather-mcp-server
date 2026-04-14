<div align="center">
  <h1>@cyanheads/nws-weather-mcp-server</h1>
  <p><b>Real-time US weather data via the National Weather Service API. Forecasts, alerts, and observations with zero auth.</b></p>
  <p><b>5 Tools · 1 Resource</b></p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/nws-weather-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/nws-weather-mcp-server) [![Version](https://img.shields.io/badge/Version-0.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) 

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.2+-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

**Public Hosted Server:** [https://nws.caseyjhand.com/mcp](https://nws.caseyjhand.com/mcp)

</div>

---

## Tools

Five tools for real-time US weather data:

| Tool | Description |
|:----------|:------------|
| `nws_get_forecast` | 7-day or hourly forecast for coordinates. Resolves NWS grid internally. |
| `nws_search_alerts` | Active weather alerts filtered by area, point, zone, event, severity, urgency, certainty, and status. |
| `nws_get_observations` | Current conditions by coordinates (nearest station) or station ID. |
| `nws_find_stations` | Nearby observation stations sorted by distance with bearing. |
| `nws_list_alert_types` | All valid alert event type names for filter discovery. |

### `nws_get_forecast`

Get the weather forecast for a US location.

- Default returns named 12-hour periods (14 total, ~7 days)
- Hourly mode returns up to 156 one-hour periods with dewpoint and humidity
- Coordinates resolve to NWS grid internally via `/points` endpoint
- Formatted timestamps use the resolved local time zone
- Returns forecast zone and county zone codes for chaining into `nws_search_alerts`

---

### `nws_search_alerts`

Search active weather alerts with flexible filtering.

- Filter by area (state/territory/marine codes), point (lat,lon), zone, event type, severity, urgency, certainty, or status
- National search when no filters provided
- Event matching is case-insensitive and partial, so `"tornado"` matches both watches and warnings
- `status` defaults to live `Actual` alerts, but can be set to `Exercise`, `System`, `Test`, or `Draft`
- Results capped at 25 with truncation notice and guidance to narrow filters
- Validates area codes and point format before API call

---

### `nws_get_observations`

Current measured conditions from a weather station.

- Look up by coordinates (finds nearest station) or station ID directly
- Coordinate lookups choose the nearest station from the candidates returned by NWS
- Dual-unit display: F/C, mph/km/h, inHg/hPa, mi/km
- Observation timestamps use the station's local time zone when available
- Warns when most measurements are unavailable from a station

---

### `nws_find_stations`

Discover nearby observation stations.

- Sorted by haversine distance from query point
- Returns distance (km) and compass bearing
- Includes zone codes, elevation, time zone
- Useful for finding station IDs for `nws_get_observations`

---

### `nws_list_alert_types`

List all valid NWS alert event type names.

- Returns the full set of event types the NWS API recognizes (e.g., "Tornado Warning", "Heat Advisory")
- Use to discover valid values for the `event` filter in `nws_search_alerts`

## Resources

| URI Pattern | Description |
|:------------|:------------|
| `nws://alert-types` | Static list of all valid NWS alert event type names. |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

NWS-specific:

- Zero-auth access to the NWS API — no API keys required
- Automatic coordinate-to-grid resolution with caching (1h TTL)
- Request timeouts plus retry/backoff for transient NWS API failures
- Dual-unit display for observations (F/C, mph/km/h, inHg/hPa, mi/km)
- Continental US, Alaska, Hawaii, and US territories coverage

## Getting started

### Public Hosted Instance

A public instance is available at `https://nws.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "nws-weather": {
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
    "nws-weather": {
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
    "nws-weather": {
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
    "nws-weather": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/nws-weather-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Node.js v22+](https://nodejs.org/) or [Bun v1.2+](https://bun.sh/)

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
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/services/nws/` | NWS API client and response types. |
| `src/config/` | Environment variable parsing and validation with Zod. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for domain-specific logging, `ctx.state` for storage
- Add new tools/resources to the barrel exports and the `createApp()` arrays in `src/index.ts`

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
