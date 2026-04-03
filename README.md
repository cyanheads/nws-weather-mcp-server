<div align="center">
  <h1>@cyanheads/nws-weather-mcp-server</h1>
  <p><b>Real-time US weather data via the National Weather Service API. Forecasts, alerts, and observations with zero auth.</b></p>
  <p><b>5 Tools · 1 Resource</b></p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/nws-weather-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/nws-weather-mcp-server) [![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/)

</div>

---

## Tools

Five tools for real-time US weather data:

| Tool Name | Description |
|:----------|:------------|
| `nws_get_forecast` | 7-day or hourly forecast for coordinates. Resolves NWS grid internally. |
| `nws_search_alerts` | Active weather alerts filtered by area, point, zone, event, severity. |
| `nws_get_observations` | Current conditions by coordinates (nearest station) or station ID. |
| `nws_find_stations` | Nearby observation stations sorted by distance with bearing. |
| `nws_list_alert_types` | All valid alert event type names for filter discovery. |

### `nws_get_forecast`

Get the weather forecast for a US location.

- Default returns named 12-hour periods (14 total, ~7 days)
- Hourly mode returns up to 156 one-hour periods with dewpoint and humidity
- Coordinates resolve to NWS grid internally via `/points` endpoint
- Dual-unit display: temperatures in both F and C

---

### `nws_search_alerts`

Search active weather alerts with flexible filtering.

- Filter by area (state/territory/marine codes), point (lat,lon), zone, event type, severity, urgency, certainty
- National search when no filters provided
- Results capped at 25 with truncation notice and guidance to narrow filters
- Validates area codes and point format before API call

---

### `nws_get_observations`

Current measured conditions from a weather station.

- Look up by coordinates (finds nearest station) or station ID directly
- Dual-unit display: F/C, mph/km/h, inHg/hPa, mi/km
- Warns when most measurements are unavailable from a station

---

### `nws_find_stations`

Discover nearby observation stations.

- Sorted by haversine distance from query point
- Returns distance (km) and compass bearing
- Includes zone codes, elevation, time zone
- Useful for finding station IDs for `nws_get_observations`

## Resources

| URI Pattern | Description |
|:------------|:------------|
| `nws://alert-types` | Static list of all valid NWS alert event type names. |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) from the same codebase

NWS-specific:

- Zero-auth access to the NWS API — no API keys required
- Automatic coordinate-to-grid resolution with caching (1h TTL)
- Retry with backoff for transient NWS API failures
- Dual-unit display for all measurements (imperial + metric)
- Continental US, Alaska, Hawaii, and US territories coverage

## Getting Started

### npx (no install)

```bash
npx @cyanheads/nws-weather-mcp-server run start:stdio
```

### MCP Client Config

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nws-weather": {
      "command": "npx",
      "args": ["-y", "@cyanheads/nws-weather-mcp-server", "run", "start:stdio"]
    }
  }
}
```

### HTTP Transport

```json
{
  "mcpServers": {
    "nws-weather": {
      "type": "streamable-http",
      "url": "http://localhost:3010/mcp"
    }
  }
}
```

Start the HTTP server:

```bash
MCP_TRANSPORT_TYPE=http npx @cyanheads/nws-weather-mcp-server run start:http
```

### Prerequisites

- [Node.js v22+](https://nodejs.org/) or [Bun v1.2+](https://bun.sh/)

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/nws-weather-mcp-server.git
```

2. **Install dependencies:**

```sh
cd nws-weather-mcp-server
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

## Running the Server

### Local Development

- **Build and run the production version:**

  ```sh
  bun run build
  bun run start:http   # or start:stdio
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck     # Lints, formats, type-checks
  bun run test         # Runs test suite
  ```

### Docker

```sh
docker build -t nws-weather-mcp-server .
docker run -p 3010:3010 nws-weather-mcp-server
```

## Project Structure

| Directory | Purpose |
|:----------|:--------|
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/services/nws/` | NWS API client and response types. |
| `src/config/` | Environment variable parsing and validation with Zod. |

## Development Guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for domain-specific logging, `ctx.state` for storage
- Register new tools and resources in the `index.ts` barrel files

## Contributing

Issues and pull requests are welcome. Run checks before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
