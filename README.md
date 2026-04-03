# nws-weather-mcp-server

[![npm version](https://img.shields.io/npm/v/@cyanheads/nws-weather-mcp-server.svg)](https://www.npmjs.com/package/@cyanheads/nws-weather-mcp-server)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

Real-time US weather via the [National Weather Service API](https://www.weather.gov/documentation/services-web-api). Forecasts, alerts, and observations -- zero auth required.

Built on [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core). Supports stdio and HTTP transports.

## What it does

- **Forecasts** -- 7-day or hourly breakdowns for any US coordinates
- **Alerts** -- Active watches, warnings, and advisories with flexible filtering
- **Observations** -- Current measured conditions from weather stations
- **Station discovery** -- Find nearby observation stations by proximity

## Tools (5)

| Tool | Description |
|:-----|:------------|
| `nws_get_forecast` | 7-day or hourly forecast for coordinates. Resolves NWS grid internally. |
| `nws_search_alerts` | Active weather alerts filtered by area, point, zone, event, severity. |
| `nws_get_observations` | Current conditions by coordinates (nearest station) or station ID. |
| `nws_find_stations` | Nearby observation stations sorted by distance with bearing. |
| `nws_list_alert_types` | All valid alert event type names for filter discovery. |

## Resources (1)

| Resource | Description |
|:---------|:------------|
| `nws://alert-types` | Static list of alert event type names. |

## Quick start

### npx (no install)

```bash
npx @cyanheads/nws-weather-mcp-server run start:stdio
```

### Install globally

```bash
npm install -g @cyanheads/nws-weather-mcp-server
nws-weather-mcp-server
```

### Claude Desktop / Cursor

Add to your MCP config:

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

### HTTP transport

```bash
MCP_TRANSPORT_TYPE=http npx @cyanheads/nws-weather-mcp-server run start:http
```

Listens on `http://127.0.0.1:3010/mcp` by default. Configure with `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_HTTP_ENDPOINT_PATH`.

## Configuration

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `NWS_USER_AGENT` | No | `(nws-weather-mcp-server, ...)` | User-Agent for NWS API requests. The API requires this header. |
| `MCP_TRANSPORT_TYPE` | No | `stdio` | Transport: `stdio` or `http`. |
| `MCP_LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn`, `error`. |

See `.env.example` for the full list including HTTP transport and OpenTelemetry options.

## Coverage

The NWS API covers the continental US, Alaska, Hawaii, and US territories. Coordinates outside US coverage return a clear error message. No geocoding is included -- provide decimal lat/lon directly.

## Development

```bash
git clone https://github.com/cyanheads/nws-weather-mcp-server.git
cd nws-weather-mcp-server
bun install
bun run build
bun run test
bun run devcheck   # lint + format + typecheck + audit
```

## License

[Apache 2.0](LICENSE)
