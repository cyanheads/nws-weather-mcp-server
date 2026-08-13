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
| `hourly` | boolean | No | If true, returns hourly forecast (48 one-hour periods per page; upstream carries ~156 over 7 days) instead of 12-hour named periods (14 periods). Default false. Hourly mode includes dewpoint and relative humidity not present in period mode. |
| `cursor` | string | No | Opaque continuation token from a previous response's `nextCursor`, selecting the next 48-period window. Omit for the first page. |

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
| `zone` | string | No | NWS forecast zone (e.g., "WAZ558") or county zone (e.g., "WAC033"). Both zone types are valid here. Get zone IDs from `nws_get_forecast` response metadata or the `/points` endpoint. |
| `region_type` | string | No | Restrict to land or marine alerts: "Land" or "Marine". Sent upstream lowercased. Mutually exclusive with `area`, `point`, `zone`, and `region`. |
| `region` | string[] | No | NWS marine region groups: "AL" (Alaska waters), "AT" (Atlantic Ocean), "GL" (Great Lakes), "GM" (Gulf of Mexico), "PA" (Eastern Pacific and US West Coast), "PI" (Central and Western Pacific). Sent upstream comma-joined. Marine alerts only. Mutually exclusive with `area`, `point`, `zone`, and `region_type`. |
| `event` | string[] | No | Filter to specific event types (e.g., ["Tornado Warning", "Severe Thunderstorm Warning"]). Accepts partial matches and is case-insensitive -- "tornado" matches "Tornado Warning" and "Tornado Watch". Use `nws_list_alert_types` to discover valid event names. |
| `severity` | string[] | No | Filter by severity: "Extreme", "Severe", "Moderate", "Minor", "Unknown". Accepts multiple. |
| `urgency` | string[] | No | Filter by urgency: "Immediate", "Expected", "Future", "Past". Accepts multiple. |
| `certainty` | string[] | No | Filter by certainty: "Observed", "Likely", "Possible", "Unlikely", "Unknown". Accepts multiple. |
| `status` | string | No | Alert status filter. Default "Actual". Options: "Actual", "Exercise", "System", "Test", "Draft". Almost always want "Actual". |
| `limit` | number | No | Alerts per page (1-25, default 25). Client-side only -- never sent upstream. `totalCount` still reports the full match count. |
| `cursor` | string | No | Opaque continuation token from a previous response's `nextCursor`. Omit for the first page. The token carries its own page size, so `limit` shapes the first page only. |

**API endpoint:** `GET /alerts/active` with query params.

**Returns:** Array of alerts: `id`, `event`, `headline`, `description`, `instruction` (recommended actions), `severity`, `urgency`, `certainty`, `areaDesc`, `senderName`, plus two distinct groups of timestamps and lifecycle state:

- **Hazard timing:** `onset` (hazard begin), `ends` (hazard end; `null` when open-ended).
- **Message lifecycle:** `sent` (when the office transmitted this CAP message), `effective` (when this message version takes effect -- a message property, not the hazard's), `expires` (when a superseding statement is due), `status` (the alert's own CAP status, distinct from the `status` request filter), `messageType` (`Alert` original issuance / `Update` / `Cancel`), and `references` (prior messages this one supersedes, as `identifier` + `sent`; empty for an original issuance).

Also includes `affectedZones`, each entry a `code` plus its NWS `type` (`forecast`, `county`, or `fire`). Only `forecast` entries chain into `nws_get_zone_forecast`; every type is a valid value for this tool's own `zone` filter. Empty array when no alerts match -- this is good news, not an error.

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
| `limit` | number | No | Stations per page (1-50, default 10). The API may return up to ~70 stations for a grid cell. |
| `cursor` | string | No | Opaque continuation token from a previous response's `nextCursor`. Omit for the first page. The token carries its own page size, so `limit` shapes the first page only. |

**API flow:** `GET /points/{lat},{lon}` -> follow `observationStations` URL.

**Returns:** Array of stations sorted by distance: `stationId` (e.g., "KSEA"), `name`, `elevation`, `distance`, `bearing` (from query point), `timeZone`, `county`, `forecastZone`.

---

### `nws_list_alert_types`

Lists all valid NWS alert event type names (111 types as of 2026). Use to discover valid values for the `event` filter in `nws_search_alerts`, or to browse alert categories. No parameters.

**API endpoint:** `GET /alerts/types`

**Returns:** Array of event type names sorted alphabetically (e.g., "Blizzard Warning", "Flash Flood Watch", "Tornado Warning"). Cached -- the set changes rarely.

---

### `nws_get_office_discussion`

Fetches the latest narrative product from a Weather Forecast Office (WFO). Primarily used for Area Forecast Discussions (AFD) that explain the meteorological reasoning behind forecasts — synoptic setup, model guidance, forecaster confidence.

**Input:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `office` | string | Yes | 3-letter WFO code (e.g., "SEW"). Returned as the `office` field by `nws_get_forecast`. |
| `product_type` | string | No | `AFD` (default), `HWO`, `ZFP`, or `SPS`. |

**API endpoints (two-hop):**

1. `GET /products/types/{product_type}/locations/{office}` — lists products, newest first; `@graph[0]` is the latest
2. `GET /products/{id}` — retrieves full product text

**DX trap:** An unknown office returns HTTP 200 with an empty `@graph`, not a 404. Detect the empty list and throw a `no_products` error with recovery instructions.

**Returns:** `productText` (full narrative), `issuanceTime`, `issuingOffice`, `productName`, `productCode`, `wmoCollectiveId`.

---

### `nws_get_zone_forecast`

Fetches the text-based forecast for a public NWS forecast zone. Returns named periods (e.g., "Today", "Tonight") with narrative text from local forecasters. Completes the alert-to-forecast chain — `nws_search_alerts` returns zones in `affectedZones` as `code` + `type`, and `nws_find_stations` returns `forecastZone`. Only `affectedZones` entries typed `forecast` resolve here; `county` and `fire` zones have no text forecast product upstream.

**Input:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `zone_id` | string | Yes | Public forecast zone code (e.g., "WAZ315"). Returned by `nws_get_forecast` (`forecastZone`), `nws_find_stations` (`forecastZone`), and `nws_search_alerts` (the `code` of an `affectedZones` entry with `type: "forecast"`). |

**API endpoint:** `GET /zones/forecast/{zone_id}/forecast`

A 404 means an invalid or unsupported zone (county codes `XXC###` are not supported — use the forecast zone code `XXZ###`).

**Returns:** `zoneId`, `updated`, `periods` (number, name, detailedForecast).

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
- **No `limit` or cursor param on alerts.** The `/alerts/active` endpoints don't support a `limit` query parameter (returns 400) and offer no upstream cursor. The service fetches and filters the whole active collection; `limit` and `cursor` window that array locally, via the framework's `paginateArray`.
- **Hourly forecast = 156 periods.** The hourly endpoint returns 7 days of hourly data. The handler windows returned periods to 48 so `structuredContent` and `content[]` carry the same bounded set -- the pre-page total and a truncation notice are surfaced via enrichment, and `nextCursor` reaches the rest.
- **Continuation is local to one fetch.** All three paged tools re-fetch their collection on every call and cache nothing but `/points` grid resolution, so consecutive pages are contiguous within a single response, not across separate calls. Harmless for the near-static station registry, and near-harmless for forecasts (reissued a few times a day); the active-alert set churns continuously, so a `nws_search_alerts` page 2 is a second, independent snapshot.
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
