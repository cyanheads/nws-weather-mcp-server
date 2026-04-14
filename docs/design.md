---
name: nws-weather-mcp-server
status: designed
priority: high
difficulty: medium
category: weather
api_docs: https://www.weather.gov/documentation/services-web-api
---

# NWS Weather MCP Server

## Overview

Real-time US weather data via the National Weather Service API. Forecasts (7-day and hourly), active severe weather alerts, and current station observations -- all with zero auth (just a User-Agent header). Covers the continental US, Alaska, Hawaii, and US territories.

Narrower scope than a full NOAA server: no historical climate data, no CDO API, no token management. Trades breadth for simplicity and zero-config deployment.

**Dependencies**: `zod`, `@cyanheads/mcp-ts-core`

---

## General Workflow

The NWS API is coordinate-centric. Most workflows start with a lat/lon pair.

1. **Forecasts**: Coordinates resolve to a grid cell via `/points/{lat},{lon}` (returns WFO office, gridX/Y). The grid cell maps to forecast endpoints. `nws_get_forecast` handles both steps internally -- the LLM just provides coordinates.
2. **Alerts**: Independent of the grid system. Query by state, point, zone, or nationally. No resolution step needed.
3. **Observations**: Station-based. `nws_get_observations` accepts coordinates (resolves nearest station internally) or a station ID directly.
4. **Stations**: Discovery tool for browsing nearby stations. Optional -- most agents won't need it since `nws_get_observations` resolves stations automatically.

The `/points` response is highly cacheable (grid cells don't change). Cache for hours to avoid redundant lookups when the same location is queried repeatedly.

---

## Tools

### `nws_get_forecast`

Retrieves the weather forecast for a US location. Provide coordinates and get back either named periods ("Today", "Tonight", "Thursday") or hourly breakdowns. Internally resolves coordinates to the NWS grid via `/points`, then fetches the forecast.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `latitude` | number | Yes | Latitude in decimal degrees (e.g., `47.6062`). Truncated to 4 decimal places per API requirement. |
| `longitude` | number | Yes | Longitude in decimal degrees (e.g., `-122.3321`). Truncated to 4 decimal places. |
| `hourly` | boolean | No | If true, returns hourly forecast (~156 periods over 7 days) instead of 12-hour named periods (14 periods). Default false. Hourly mode includes dewpoint and relative humidity not present in period mode. |

**API flow:** `GET /points/{lat},{lon}` -> follow `forecast` or `forecastHourly` URL from response properties.

**Returns:** Location context (city, state, WFO office, time zone, forecast zone, county zone) plus array of forecast periods: `name`, `startTime`, `endTime`, `temperature`, `temperatureUnit`, `windSpeed`, `windDirection`, `shortForecast`, `detailedForecast`, `probabilityOfPrecipitation`. Hourly adds `dewpoint`, `relativeHumidity`.

**Error modes:**
- Coordinates outside US coverage -> "NWS only covers the US. Provide coordinates within US states, territories, or adjacent marine areas."
- API returns 500 for grid endpoint -> Transient. Retry. The NWS backend occasionally fails on grid lookups.

---

### `nws_search_alerts`

Searches active weather alerts (watches, warnings, advisories) across the US. Use to check for severe weather threats, find active warnings for a state or location, or filter for specific hazard types. At least one location filter should be provided, or omit all for a national search.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `area` | string | No | US state/territory code (e.g., "WA", "OK", "PR") or marine area code (e.g., "GM" for Gulf of Mexico). Most common filter. |
| `point` | string | No | Coordinates as "lat,lon" (e.g., "47.6,-122.3"). Returns alerts whose geometry contains this point. More precise than `area` but may miss alerts with imprecise geometries. |
| `zone` | string | No | NWS forecast zone (e.g., "WAZ558") or county zone (e.g., "WAC033"). Get zone IDs from `nws_get_forecast` response metadata or the `/points` endpoint. |
| `event` | string[] | No | Filter to specific event types (e.g., ["Tornado Warning", "Severe Thunderstorm Warning"]). Accepts partial matches and is case-insensitive -- "tornado" matches "Tornado Warning" and "Tornado Watch". Use `nws_list_alert_types` to discover valid event names. |
| `severity` | string[] | No | Filter by severity: "Extreme", "Severe", "Moderate", "Minor", "Unknown". Accepts multiple. |
| `urgency` | string[] | No | Filter by urgency: "Immediate", "Expected", "Future", "Past". Accepts multiple. |
| `certainty` | string[] | No | Filter by certainty: "Observed", "Likely", "Possible", "Unlikely", "Unknown". Accepts multiple. |
| `status` | string | No | Alert status filter. Default "Actual". Options: "Actual", "Exercise", "System", "Test", "Draft". Almost always want "Actual". |

**API endpoint:** `GET /alerts/active` with query params.

**Returns:** Array of alerts: `id`, `event`, `headline`, `description`, `instruction` (recommended actions), `severity`, `urgency`, `certainty`, `areaDesc`, `onset`, `expires`, `senderName`. Also includes `affectedZones` (zone IDs for chaining). Empty array when no alerts match -- this is good news, not an error.

---

### `nws_get_observations`

Retrieves current weather observations (actual measured conditions, not forecasts). Accepts either coordinates or a station ID. When given coordinates, automatically resolves the nearest observation station.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `latitude` | number | No | Latitude for automatic station resolution. Use with `longitude`. Ignored if `station_id` is provided. |
| `longitude` | number | No | Longitude for automatic station resolution. Use with `latitude`. Ignored if `station_id` is provided. |
| `station_id` | string | No | Station identifier directly (e.g., "KSEA", "KORD"). ICAO airport codes are the most common. Use `nws_find_stations` to discover station IDs. |

One of `station_id` or `latitude`+`longitude` is required.

**API flow:** If coordinates given: `GET /points/{lat},{lon}` -> follow `observationStations` -> pick first station -> `GET /stations/{id}/observations/latest`. If station_id given: direct fetch.

**Returns:** Station name and ID, observation timestamp, station time zone, plus measured values: `temperature`, `dewpoint`, `windSpeed`, `windDirection`, `windGust`, `barometricPressure`, `visibility`, `relativeHumidity`, `heatIndex`, `windChill`, `textDescription` (e.g., "Mostly Cloudy"), `cloudLayers`. Values include units. Some fields may be null if the station doesn't report that metric (common for windGust, heatIndex, windChill).

**Error modes:**
- Station has no recent observations -> "Station {id} has no recent observations. Try a different station -- use nws_find_stations to find alternatives nearby."

---

### `nws_find_stations`

Finds weather observation stations near a location. Use to discover station IDs, compare available stations, or find the closest reporting station. Results sorted by proximity.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `latitude` | number | Yes | Center latitude for proximity search. |
| `longitude` | number | Yes | Center longitude for proximity search. |
| `limit` | number | No | Max stations to return (1-50, default 10). The API may return up to ~70 stations for a grid cell. |

**API flow:** `GET /points/{lat},{lon}` -> follow `observationStations` URL.

**Returns:** Array of stations sorted by distance: `stationId` (e.g., "KSEA"), `name`, `elevation`, `distance`, `bearing` (from query point), `timeZone`, `county`, `forecastZone`.

---

### `nws_list_alert_types`

Lists all valid NWS alert event type names (111 types as of 2026). Use to discover valid values for the `event` filter in `nws_search_alerts`, or to browse alert categories. No parameters.

**API endpoint:** `GET /alerts/types`

**Returns:** Array of event type names sorted alphabetically (e.g., "Blizzard Warning", "Flash Flood Watch", "Tornado Warning"). Cached -- the set changes rarely.

---

## Resources

### `nws://alert-types`

Static list of all valid NWS alert event type names (111 types). Useful reference when constructing `event` filters for `nws_search_alerts`. Fetched from `/alerts/types` and cached.

**Tool coverage:** Fully covered by `nws_list_alert_types`. This resource is a convenience for clients that support resource injection.

---

## Implementation Notes

### API Characteristics

| Aspect | Detail |
|---|---|
| **Base URL** | `https://api.weather.gov` |
| **Auth** | None. User-Agent header required (returns 403 without it). Format: `(app-name, contact@example.com)`. |
| **Rate limits** | Undisclosed. "Generous for typical use." Retry after ~5s on 503. |
| **Response format** | GeoJSON (default, via `Accept: application/geo+json`) or JSON-LD. |
| **Coverage** | US states, territories, and adjacent marine areas only. |
| **Observation lag** | Station data lags ~20 minutes due to upstream QC (MADIS). |
| **Grid caching** | `/points` responses (grid cell mapping) change infrequently. Cache for hours. |

### API Quirks

- **No geocoding.** The API is coordinates-only. The server should require lat/lon from the LLM. Adding internal geocoding (Census Bureau or Nominatim) is a nice-to-have but adds a dependency for marginal gain -- most LLMs can provide coordinates when asked.
- **No `limit` param on alerts.** The `/alerts/active` endpoints don't support a `limit` query parameter (returns 400). Filter by area/severity to control result size.
- **Hourly forecast = 156 periods.** The hourly endpoint returns 7 days of hourly data. Truncate in `format()` output to avoid flooding context -- show next 24-48h and note the remainder.
- **Observation units are metric.** Temperature in Celsius, wind in km/h, pressure in Pa. Convert to a readable format in `format()` (F/C with both shown, mph, inHg/hPa).
- **Grid endpoint 500s.** The NWS backend occasionally returns 500 on gridpoint forecast requests. These are transient -- retry with backoff.
- **`/points` is the routing layer.** Almost every workflow starts here. The response contains URLs for forecast, hourly forecast, observation stations, forecast zone, county, and fire weather zone. Parse and follow these rather than constructing grid URLs manually.

### Config

| Env Var | Required | Description |
|---|---|---|
| `NWS_USER_AGENT` | No | Custom User-Agent string. Default: `(nws-weather-mcp-server, github.com/cyanheads/nws-weather-mcp-server)`. |

---

## References

- [NWS API Documentation](https://www.weather.gov/documentation/services-web-api)
- [NWS API OpenAPI Spec](https://api.weather.gov/openapi.json)
- [NWS API Community Docs (GitHub)](https://weather-gov.github.io/api/)
- [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)
