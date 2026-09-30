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

Real-time US weather data via the National Weather Service API. Forecasts (7-day and hourly), active severe weather alerts and national alert counts, and current station observations plus about 7 days of observation history -- all with zero auth (just a User-Agent header). Covers the continental US, Alaska, Hawaii, and US territories.

Narrower scope than a full NOAA server: no historical climate data, no CDO API, no token management. Trades breadth for simplicity and zero-config deployment.

**Dependencies**: `zod`, `@cyanheads/mcp-ts-core`

---

## General Workflow

The NWS API is coordinate-centric. Most workflows start with a lat/lon pair.

1. **Forecasts**: Coordinates resolve to a grid cell via `/points/{lat},{lon}` (returns WFO office, gridX/Y). The grid cell maps to forecast endpoints. `nws_get_forecast` handles both steps internally -- the LLM just provides coordinates.
2. **Alerts**: Independent of the grid system. Query by state, point, zone, or nationally. No resolution step needed. `nws_get_alert_counts` answers "how many, and where" nationally without fetching the alerts.
3. **Observations**: Station-based. `nws_get_observations` accepts coordinates (resolves nearest station internally) or a station ID directly. `nws_get_observation_history` takes a station ID and pages back through the station's last ~7 days.
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
- Coordinates outside US coverage -> `out_of_scope`: "NWS only covers the US. Provide coordinates within US states or territories."
- Marine coordinates -> `marine_forecast_unsupported` (NotFound). Two upstream shapes: a gridded marine cell whose gridpoint forecast answers 404 with problem type `MarineForecastNotSupported`, and an offshore point beyond the grid whose `/points` answers 200 with `type: "marine"` and every grid URL null — the latter fails without a gridpoint call. `nws_find_stations` returns an empty list and `nws_get_observations` raises `no_stations_nearby` for that gridless shape; a gridded marine cell still serves both.
- Land coordinates NWS serves no forecast grid for -> `no_forecast_grid` (NotFound, logged at `notice`). `/points` answers 200 with `type: "land"`, every grid URL null, and a real forecast zone (interior points of the Northern Mariana Islands zones MPZ005–MPZ007, e.g. Pagan in MPZ006). The error names the point and its `forecastZone`, and the recovery routes to `nws_search_alerts` with that zone. `nws_find_stations` and `nws_get_observations` give the gridless-marine no-stations answers. A land `/points` 200 missing only some grid URLs is still a malformed response (ServiceUnavailable).
- A 500 on the gridpoint forecast, station list, or observation URL -> retried (3 attempts, 2 s then 4 s), then the baseline ServiceUnavailable. The NWS backend occasionally fails on grid lookups.
- A `/points` 500 that outlives the same retry budget -> the same ServiceUnavailable (no declared reason, `data.status`/`url`/`retryAttempts` kept), with a message naming the truncated coordinates and a `data.recovery.hint` giving both readings: NWS answers some open-ocean points outside its marine zones (much of the tropical Atlantic, Caribbean, and Gulf, e.g. `25,-70`) with a 500 on every request, so a point at sea should move toward the US coast; on land, NWS is failing and a later retry may succeed. The body is NWS's generic `UnexpectedProblem` document either way, so no extra request is made to tell them apart. Applies to `nws_find_stations` and `nws_get_observations` (coordinates) too. A 501 and a gateway status (502–504) at `/points` surface unchanged.

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
| `limit` | number | No | Alerts per page (1-25, default 25). Client-side only -- never sent upstream. `totalCount` still reports the full distinct-alert match count. |
| `cursor` | string | No | Opaque continuation token from a previous response's `nextCursor`. Omit for the first page. The token carries its own page size, so `limit` shapes the first page only. |

**API endpoint:** `GET /alerts/active` with query params.

**Returns:** Array of alerts: `id`, `event`, `headline`, `description`, `instruction` (recommended actions), `severity`, `urgency`, `certainty`, `areaDesc`, `senderName`, plus two distinct groups of timestamps and lifecycle state:

- **Hazard timing:** `onset` (hazard begin), `ends` (hazard end; `null` when open-ended).
- **Message lifecycle:** `sent` (when the office transmitted this CAP message), `effective` (when this message version takes effect -- a message property, not the hazard's), `expires` (when a superseding statement is due), `status` (the alert's own CAP status, distinct from the `status` request filter), `messageType` (`Alert` original issuance / `Update` / `Cancel`), and `references` (prior messages this one supersedes, as `identifier` + `sent`; empty for an original issuance).

Also includes `affectedZones`, each entry a `code` plus its NWS `type` (`forecast`, `county`, or `fire`). Only `forecast` entries chain into `nws_get_zone_forecast`; every type is a valid value for this tool's own `zone` filter. Empty array when no alerts match -- this is good news, not an error.

**Error modes:**
- A `point` search whose 500 outlives the retry budget -> ServiceUnavailable naming the point, with a `data.recovery.hint`: the same open-ocean points that 500 at `/points` also 500 at `/alerts/active?point=` (e.g. `25,-70`, `22,-65`, `30,-70`), so a point at sea should search by marine `region` (e.g. `AT`) or a marine `area`/`zone` filter instead; on land, a later retry may succeed. An exhausted 500 on a search without `point` keeps the baseline message.

---

### `nws_get_alert_counts`

Counts active weather alerts nationwide, per state/territory or marine area, and per marine region, in one small response. Answers "how many alerts are active, and where" without fetching the alerts themselves, which `nws_search_alerts` has to do even for a national count. No parameters.

**API endpoint:** `GET /alerts/active/count`, with no query parameters. The endpoint rejects every query parameter with a 400, so the tool takes no filters.

**Returns:** `totalAlerts`, `landAlerts`, `marineAlerts`, plus two sparse count maps: `areas`, keyed by state/territory code (`WA`, `PR`) or marine area code (`PZ`, `GM`), and `regions`, keyed by marine region (`AL` Alaska waters, `AT`, `GL`, `GM`, `PA`, `PI`). Only codes with an active alert appear, so either map can be empty; a land-only result with an empty `regions` is a success. Area `AL` is Alabama; region `AL` is Alaska waters. `format()` renders every area and region sorted by count descending, each region labeled by name.

Two counting rules make these numbers differ from `nws_search_alerts`:

- Counts cover every CAP message status (Actual, Exercise, System, Test, Draft), so `totalAlerts` can run above the `totalCount` of a national `nws_search_alerts` search, which defaults to `status: Actual`.
- An alert counts once in each area its zones fall in, so `areas` can sum past `totalAlerts`; `landAlerts + marineAlerts = totalAlerts`.

**Decision:** the upstream `zones` map is dropped. It is nearly all of the response and grows with the active set, and a zone-level count is one `nws_search_alerts` call away (`zone` filter, read `totalCount`). The same call answers a count under any other filter.

**Error modes:** No declared reasons. Upstream failures surface as baseline codes (ServiceUnavailable, Timeout, …).

---

### `nws_get_observations`

Retrieves current weather observations (actual measured conditions, not forecasts). Accepts either coordinates or a station ID. When given coordinates, automatically resolves the nearest observation station.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `latitude` | number | No | Latitude for automatic station resolution. Use with `longitude`. Ignored if `station_id` is provided. |
| `longitude` | number | No | Longitude for automatic station resolution. Use with `latitude`. Ignored if `station_id` is provided. |
| `station_id` | string | No | Station identifier directly (e.g., "KSEA", "KORD"). ICAO airport codes are the most common. Use `nws_find_stations` to discover station IDs. |

One of `station_id` or `latitude`+`longitude` is required.

**API flow:** If coordinates given: `GET /points/{lat},{lon}` -> follow `observationStations` -> pick the nearest station -> `GET /stations/{id}/observations/latest`. If station_id given: direct fetch.

**Returns:** Station name and ID, observation timestamp, station time zone, plus measured values: `temperature`, `dewpoint`, `windSpeed`, `windDirection`, `windGust`, `barometricPressure`, `visibility`, `relativeHumidity`, `heatIndex`, `windChill`, `textDescription` (e.g., "Mostly Cloudy"), `cloudLayers`. Values include units. Some fields may be null if the station doesn't report that metric (common for windGust, heatIndex, windChill).

**Error modes:**
- Station has no recent observations -> `no_observations`: "Station {id} has no recent observations." Both paths raise it for a 404 on `/stations/{id}/observations/latest` and for a latest observation with no timestamp; on the coordinate path the station came from NWS's own list, so a 404 there never reads as `station_not_found`.
- An unknown `station_id` -> `station_not_found`, settled by the station-metadata request.
- No station near the coordinates (including points beyond the forecast grid) -> `no_stations_nearby`.

---

### `nws_get_observation_history`

Pages back through one station's recent observations, newest first: the trend behind the single latest reading `nws_get_observations` returns (is pressure falling, is the wind picking up). NWS keeps about the last 7 days per station, and a busy airport station reports as often as every 5 minutes, so a day can run past 100 observations.

**Decision:** a separate tool rather than a mode of `nws_get_observations`, whose flat single-observation output would otherwise become a list/detail union. The name keeps the two apart, since both take a station ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `station_id` | string | Yes | Observation station ID (e.g., "KSEA"), case-insensitive; uppercased before use. Use `nws_find_stations` to discover IDs near a coordinate. |
| `start` | string | No | Earliest observation time to include (inclusive), as an ISO 8601 date-time with seconds and an offset (e.g., `2026-09-30T00:00:00Z`, `2026-09-29T17:00:00-07:00`). Omit to reach back as far as NWS keeps. |
| `end` | string | No | Time to stop before (exclusive), same format. Omit to start from the most recent observation. |
| `limit` | number | No | Observations per page (1-100, default 24), newest first. Sent upstream. |
| `cursor` | string | No | Opaque continuation token from a previous response's `nextCursor`. Omit for the first page. It carries the window, so `start`, `end`, and `limit` shape the first page only. |

**API flow:** `GET /stations/{id}` and `GET /stations/{id}/observations?limit=&start=&end=` in parallel, classified station-first.

**Paging is upstream**, unlike the other paged tools: a station's history has no bounded collection to fetch and window locally. The tool mints its own cursor with `encodeCursor` (`@cyanheads/mcp-ts-core/utils`), carrying the first page's `start` and `limit`, with the oldest returned timestamp as the next `end`. NWS treats `end` as exclusive, so each page continues from just before the oldest observation of the one before it, and pages neither repeat nor skip an observation. `nextCursor` appears only when a page fills `limit`, unless the oldest observation sits on `start` itself, where the window has nothing older left.

**Decision:** NWS's own `pagination.next` is not passed through. It drops `limit`, `start`, and `end`, it appears on every non-empty page including the last, and a cursor with a malformed timestamp returns a 500.

**Returns:** `stationId` (uppercased), `stationName`, `timeZone` (null when unknown), and `observations`, newest first, each carrying the `nws_get_observations` measurement fields with the same rounding: `timestamp`, `textDescription`, `temperatureC`, `dewpointC`, `windSpeedKmh`, `windDirectionDeg`, `windGustKmh`, `barometricPressurePa`, `visibilityM`, `relativeHumidityPct`, `heatIndexC`, `windChillC`, `cloudLayers`. A measurement the station did not report is `null`, never 0. Enrichment carries `shown`, plus `truncated`, `cap`, and `nextCursor` on a full page, and a `notice` for a full page or an empty window. `format()` renders one dual-unit table row per observation.

**Error modes:**
- A `station_id` that is not a plain alphanumeric token, or one NWS has no station record for -> `station_not_found` (NotFound). NWS answers an unknown station's observation list with 200 and an empty collection, so the station record's 404 decides, even when the list came back 200.
- `start` or `end` not an ISO 8601 date-time with seconds and an offset, a date that does not exist (e.g. `2026-02-30`), or `start` not before `end` -> `invalid_time_window` (ValidationError), before any request. NWS answers a date-only value with a 400 and a calendar-invalid one with a 500.
- A malformed cursor, or one whose decoded window fails the same timestamp checks -> `-32602 InvalidParams` (`invalid_cursor`), before any request. As on the other paged tools, not a declared reason.
- A valid station with no observations in the window is a success: empty `observations` and a notice naming the ~7-day retention.

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

Failure modes, keyed on the 404 problem-document `type`:

- `InvalidZone`, or no body -> `zone_not_found` (county codes `XXC###` land here — use the forecast zone code `XXZ###`).
- `MarineForecastNotSupported` -> `marine_forecast_unsupported`. Marine forecast zones (`PZZ`, `ANZ`, `GMZ`, `LMZ`, …) have zone records and appear in marine alerts' `affectedZones` typed `forecast`, but NWS serves no text forecast for them.
- `NotFound` -> ambiguous: NWS answers this way both for a valid zone with no text product (all `PRZ`/`VIZ` zones, many Alaska zones) and for a made-up zone with an unknown state prefix (`XXZ123`). A single no-retry probe of `GET /zones/forecast/{zone_id}` settles it: 200 -> `zone_forecast_unavailable`, 404 -> `zone_not_found`.
- A 500 that outlives the retry budget (some Alaska, Guam, and Northern Mariana zones answer 500 `UnexpectedProblem` on every attempt) takes the same probe. A 501, a gateway status (502–504), and every other failure surface unchanged.
- A probe that fails with anything but 200 or 404 answers nothing about the zone: after a 500 the original ServiceUnavailable stands, after a `NotFound` 404 the probe's own failure surfaces (ServiceUnavailable, RateLimited, Timeout), and a caller disconnect is always RequestCancelled. An outage never reads as a missing zone or a missing product.

A `zone_id` that is not a plain alphanumeric token fails as `zone_not_found` without a request. The same guard covers `station_id` on `nws_get_observations` and `nws_get_observation_history` (`station_not_found`) and `office` on `nws_get_office_discussion` (`no_products`): every NWS zone, station, and office ID is alphanumeric, a `.` or `..` segment resolves onto the parent path even when percent-encoded, and an encoded traversal is refused by the upstream edge.

`zone_forecast_unavailable` (NotFound) names the upstream status and points to `nws_get_forecast` with coordinates inside the zone — NWS usually, not always, serves a point forecast where the zone text product is missing (the MPZ005–MPZ007 interiors have no forecast grid; see `no_forecast_grid`). The tool does not substitute one. The existence probe's 200 body is the zone record, whose geometry (Polygon or MultiPolygon) yields that point with no extra request: take the largest-area part, then the midpoint of the widest interior interval on a horizontal scan line through it (the JTS `InteriorPointArea` method), rounded to 4 decimals — a bounding-box center or area centroid falls outside concave and multi-part zones such as AKZ801, AKZ785, and AKZ787. The point rides `data.latitude`/`data.longitude`, the message names it, and a throw-site `data.recovery.hint` names `nws_get_forecast` with it. A record with null or unusable geometry omits both fields and keeps the contract recovery.

**Returns:** `zoneId` (uppercased), `updated`, `periods` (number, name, detailedForecast).

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
| **Coverage** | US states, territories, and adjacent marine areas only. Point and zone text forecasts are land-only: marine areas get alerts, and nearshore gridded cells also stations and observations. |
| **Observation lag** | Station data lags ~20 minutes due to upstream QC (MADIS). |
| **Grid caching** | `/points` responses (grid cell mapping) change infrequently. Cache for hours. |

### API Quirks

- **No geocoding.** The API is coordinates-only. The server should require lat/lon from the LLM. Adding internal geocoding (Census Bureau or Nominatim) is a nice-to-have but adds a dependency for marginal gain -- most LLMs can provide coordinates when asked.
- **No `limit` or cursor param on alerts.** The `/alerts/active` endpoints don't support a `limit` query parameter (returns 400) and offer no upstream cursor. The service fetches and filters the whole active collection; `limit` and `cursor` window that array locally, via the framework's `paginateArray`.
- **Hourly forecast = 156 periods.** The hourly endpoint returns 7 days of hourly data. The handler windows returned periods to 48 so `structuredContent` and `content[]` carry the same bounded set -- the pre-page total and a truncation notice are surfaced via enrichment, and `nextCursor` reaches the rest.
- **Continuation is local to one fetch.** `nws_get_forecast`, `nws_find_stations`, and `nws_search_alerts` re-fetch their collection on every call and cache nothing but `/points` grid resolution, so consecutive pages are contiguous within a single response, not across separate calls. Harmless for the near-static station registry, and near-harmless for forecasts (reissued a few times a day); the active-alert set churns continuously, so a `nws_search_alerts` page 2 is a second, independent snapshot. `nws_get_observation_history` is the exception: it pages upstream with a time-keyed cursor that continues from just before the previous page's oldest observation, so its pages do continue across calls (see its section).
- **`/alerts/active` repeats alerts within one response.** NWS emits some alerts twice in a single fetch, byte-identical in `id`, `sent`, `event`, and `areaDesc` — a multi-zone Air Quality Alert from one office is a reliable shape. The service collapses them on `id`, keeping the first occurrence, in `NwsService.searchAlerts()` on the raw feature array. That placement is deliberate: it sits ahead of both the event filter and the tool's page window, so no count is inflated and a duplicate cannot straddle a page boundary. Note this is a *different* phenomenon from the cross-call drift above — within one fetch an `id` now appears at most once, so the same `id` arriving on two pages of a page walk means the active set moved between calls.
- **Observation units are metric.** Temperature in Celsius, wind in km/h, pressure in Pa. Convert to a readable format in `format()` (F/C with both shown, mph, inHg/hPa).
- **Grid endpoint 500s.** The NWS backend occasionally returns 500 on gridpoint forecast requests. These are transient -- retry with backoff. Not every 500 is: `/points` and `/alerts/active?point=` answer 500 on every request at some open-ocean points outside the marine zones, and some zones' `/forecast` does the same. The body is the same generic `UnexpectedProblem` document as an outage, so an exhausted 500 on a point-keyed request keeps the ServiceUnavailable and adds a hint covering both readings.
- **Gridless `/points` answers.** A 200 with every grid URL null is a real answer, not a malformed one: `type: "marine"` for offshore waters beyond the grid, `type: "land"` for some remote land (interior Northern Mariana Islands). Only the forecast zone is real.
- **`/points` is the routing layer.** Almost every workflow starts here. The response contains URLs for forecast, hourly forecast, observation stations, forecast zone, county, and fire weather zone. Parse and follow these rather than constructing grid URLs manually.

### Count vocabulary on the paged tools

`nws_get_forecast`, `nws_find_stations`, and `nws_search_alerts` each fetch a whole collection and window it locally, so each reports two different quantities. They use one pair of names, matching the framework's own enrichment convention (`ctx.enrich.total()` writes `totalCount`; `ctx.enrich.truncated()` writes `shown`):

| Enrichment field | Meaning |
|---|---|
| `totalCount` | Everything that matched, before any limit or page window. Constant across the pages of one query. |
| `shown` | How many are in this response. Tracks the returned array, never the requested `limit`. |

`totalCount > shown` is the truncation signal — it is how an agent learns results were withheld and that `nextCursor` is worth following.

**Decision:** these two names replaced three per-tool vocabularies (`totalFound`/`totalCount`, `totalCount`/`shownCount`, `totalPeriodCount`/`periodCount`). `totalCount` had landed on opposite sides of the limit in two tools, so an agent that learned it from one read the other's truncation disclosure as its own opposite. The retired names were removed rather than kept as aliases: a fourth set of fields alongside the existing three would have made the surface worse, and a caller reaching for a retired name now gets `undefined` — a loud miss — instead of a silently different number.

On `nws_search_alerts`, `totalCount` counts *distinct* alerts, after the upstream duplicates described above are collapsed.

`nws_get_zone_forecast` is not part of this set: it takes no `limit` and returns every period, so its single `periodCount` is both quantities at once and cannot invert.

`nws_get_observation_history` reports `shown` and no `totalCount`, because NWS gives no total for a time window. A page that fills its `limit` carries `truncated: true` with `cap` and a `nextCursor`; that, not `totalCount > shown`, is its continuation signal.

### Blank optional inputs

Form-based clients send every optional field they display, empty ones as `""` or `[]`. A blank or whitespace-only optional string, an empty array, and an `event` array of nothing but blank terms are treated as omitted: left off the upstream request and out of `appliedFilters`. A blank enum (`region_type`, `status`, `product_type`) maps to unset before the enum validates, so `status` and `product_type` take their defaults; the advertised schemas are unchanged. Real values keep every check (mutual exclusion, `invalid_area_code`, `invalid_point`, `invalid_zone`, `invalid_time_window`), and a blank `station_id` with no coordinates is `missing_input`.

**Decision:** blanks were once rejected (`blank_location_filter`, `empty_filter_array`, `blank_station_id`) so a blank could not silently widen a search, which failed every form that fills one filter and leaves the rest empty. The widening stays visible without the rejection: `appliedFilters` echoes only the filters applied, and `nws_get_observations` names the station it served.

### Error log levels

Every declared `errors[]` reason is a modeled outcome — caller input, an unknown ID, or no current data to serve — and declares `severity: 'notice'`, so its `Error in tool:<name>` record stays out of the `error` stream that log-based alerting reads. `zone_forecast_unavailable` declares `warning`: it is also raised when the zone forecast endpoint fails while the zone record answers, so an outage of that endpoint alone surfaces only as this reason. Baseline faults (ServiceUnavailable, Timeout, …) and undeclared throws keep `error`. The level moves only the log record and the `mcp.error.severity` attribute on `mcp.errors.classified`; the error envelope, span status, and `mcp.tool.*` metrics are unchanged.

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
