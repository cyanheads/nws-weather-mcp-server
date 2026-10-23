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
2. **Alerts**: Independent of the grid system. Query by state, point, zone, or nationally. No resolution step needed. `nws_get_alert_counts` answers "how many, and where" nationally without fetching the alerts. An alert's `id`, or a `references[].identifier`, feeds `nws_get_alert` to read one message, including superseded ones, and its `office` feeds `nws_get_office_discussion` for the issuing office's products.
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
| `hourly` | boolean | No | If true, returns hourly forecast (48 one-hour periods per page; upstream carries ~156 over 7 days) instead of 12-hour named periods (14 periods). Default false. Hourly mode includes dewpoint and relative humidity not present in period mode. Sets the first page's mode only; a cursor carries its own. |
| `cursor` | string | No | Opaque continuation token from a previous response's `nextCursor`, selecting the next 48-period window. Omit for the first page. The token carries the mode it was issued in, so the next page stays hourly or 7-day whatever `hourly` says. |

**API flow:** `GET /points/{lat},{lon}` -> follow `forecast` or `forecastHourly` URL from response properties.

**Paging:** the tool mints its own token with `encodeCursor`, `{ offset, limit, hourly }`, and decodes it before any request: a malformed token, a non-integer `offset` or `limit`, or a non-boolean `hourly` fails as `-32602` `invalid_cursor` with no NWS call. A token without `hourly` (the `{ offset, limit }` shape 0.11.0 minted) reads the mode from the `hourly` input. The page size is the token's `limit`, held to 48. A cursor past the end returns an empty page whose notice names the mode and how to restart it.

**Returns:** Location context (city, state, WFO office, time zone, forecast zone, county zone), `generatedAt` (when NWS generated this response), `updateTime` (when the data the forecast was generated from was last updated, on every page in both modes; null, with no stale check, when NWS omits it), plus array of forecast periods: `name`, `startTime`, `endTime`, `temperature`, `temperatureUnit`, `windSpeed`, `windDirection`, `shortForecast`, `detailedForecast`, `probabilityOfPrecipitation`. Hourly adds `dewpoint`, `relativeHumidity`. NWS ships an empty `name` on hourly periods, so hourly mode carries a derived hour label in `name` (weekday and start time in the location time zone, e.g. `Fri 6:00 AM`); the repeated fall-back DST hour yields two identical labels, and `startTime` disambiguates. Dewpoint renders in Celsius at the structured precision (`43°F (6.1°C)`).

**Stale grid:** `generatedAt` advances whenever NWS regenerates the response, so a grid whose office stopped updating still looks fresh by it; `updateTime` does not move. When `updateTime` is more than 24 hours old, the `notice` opens with the age in hours (`Forecast data was last updated 26.3h ago — …`), ahead of any paging sentence. Offices on a ~12-hour package cycle leave gaps up to ~16.6 h in normal operation, so 24 h (about twice the cadence) marks a missed cycle rather than a routine gap.

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
| `point` | string | No | Coordinates as "lat,lon" (e.g., "47.6,-122.3"). Returns alerts whose geometry contains this point. Must lie inside NWS coverage (US states, territories, and adjacent marine areas). More precise than `area` but may miss alerts with imprecise geometries. |
| `zone` | string | No | NWS forecast zone (e.g., "WAZ558") or county zone (e.g., "WAC033"). Both zone types are valid here. Get zone IDs from `nws_get_forecast` response metadata or the `/points` endpoint. |
| `region_type` | string | No | Restrict to land or marine alerts: "Land" or "Marine". Sent upstream lowercased. Mutually exclusive with `area`, `point`, `zone`, and `region`. |
| `region` | string[] | No | NWS marine region groups: "AL" (Alaska waters), "AT" (Atlantic Ocean), "GL" (Great Lakes), "GM" (Gulf of Mexico), "PA" (Eastern Pacific and US West Coast), "PI" (Central and Western Pacific). Sent upstream comma-joined. Marine alerts only. Mutually exclusive with `area`, `point`, `zone`, and `region_type`. |
| `event` | string[] | No | Filter to specific event types (e.g., ["Tornado Warning", "Severe Thunderstorm Warning"]). Accepts partial matches and is case-insensitive -- "tornado" matches "Tornado Warning" and "Tornado Watch". Use `nws_list_alert_types` to discover valid event names. |
| `severity` | string[] | No | Filter by severity: "Extreme", "Severe", "Moderate", "Minor", "Unknown". Accepts multiple. |
| `urgency` | string[] | No | Filter by urgency: "Immediate", "Expected", "Future", "Past". Accepts multiple. |
| `certainty` | string[] | No | Filter by certainty: "Observed", "Likely", "Possible", "Unlikely", "Unknown". Accepts multiple. |
| `status` | string | No | Alert status filter. Default "Actual". Options: "Actual", "Exercise", "System", "Test", "Draft". Almost always want "Actual". |
| `limit` | number | No | Alerts per page (default 25; schema ceiling 10000). A page holds at most 25: a larger first-page limit is served as 25 and reported through `requestedLimit`/`effectiveLimit`. Client-side only -- never sent upstream. `totalCount` still reports the full distinct-alert match count. |
| `cursor` | string | No | Opaque continuation token from a previous response's `nextCursor`, sent on its own. Omit for the first page. The token carries the query's normalized filters and page size, so the filter inputs and `limit` shape the first page only; filters sent with it are ignored. A blank or whitespace-only value is the first page. |

**API endpoint:** `GET /alerts/active` with query params.

**Paging:** the tool mints its own token with `encodeCursor` (`@cyanheads/mcp-ts-core/utils`) as `{ offset, limit, filters }` — `paginateArray` re-mints `{ offset, limit }` only, so it cannot carry the query. The token is decoded before any request, and the carried filters go through the input schema, the same normalization, and the same mutual-exclusion and area/point/zone checks as the inputs; a token that fails any of them, or carries a non-integer `offset` or `limit`, fails as `-32602 InvalidParams` (`invalid_cursor`), not a declared reason. A token without `filters` (`{ offset, limit }`, the shape minted before the cursor carried its query) resumes against the filters sent with it and, sent alone, pages the national set. A carried `limit` above 25 is served as 25. The past-end notice names the cursor's filters.

**Decision:** the cursor carries its query rather than rejecting a mismatch between the token and the filters sent with it. A mismatch check would turn the documented "pass `nextCursor` back as `cursor`" step into an error unless every filter were resent in a normalized order, and `nws_get_observation_history` already carries its window the same way.

**Returns:** Array of alerts: `id`, `event`, `headline`, `description`, `instruction` (recommended actions), `severity`, `urgency`, `certainty`, `areaDesc`, `senderName` (the office's name; its code is `office`), plus two distinct groups of timestamps and lifecycle state, and the CAP parameters fields:

- **Hazard timing:** `onset` (hazard begin), `ends` (hazard end; `null` when open-ended).
- **Message lifecycle:** `sent` (when the office transmitted this CAP message), `effective` (when this message version takes effect -- a message property, not the hazard's), `expires` (when a superseding statement is due), `status` (the alert's own CAP status, distinct from the `status` request filter), `messageType` (`Alert` original issuance / `Update` / `Cancel`), and `references` (prior messages this one supersedes, as `identifier` + `sent`, newest first by `sent` instant; messages sent at the same instant keep NWS's order and one whose `sent` does not parse sorts last; empty for an original issuance). The `**Supersedes:**` line in `content[]` follows the same order, and every tool returning the alert shape inherits it.

- **CAP parameters:** four fields read from the alert's CAP `parameters` block, where NWS sends every value as an array of strings. `office` is the issuing office code (`RIW`), the `office` input of `nws_get_office_discussion`: the WMO header's issuing centre (`WWUS85 KRIW 230445` → `KRIW`) without its leading letter, except `TJSJ` → `SJU` and `NSTU` → `PPG`, and `null` for the tsunami warning centres (`PAAQ`, `PHEB`), the national test-message centre (`KWBC`), and a missing or malformed header. `vtec` keeps every raw P-VTEC string (`[]` when NWS sends none, as on Special Weather Statements). `nwsHeadline` is the product headline (`null` when absent), distinct from `headline`. `hazard` holds the severe-weather tags NWS sent — `maxHailSize`, `maxWindGust`, `hailThreat`, `windThreat`, `tornadoDetection`, `tornadoDamageThreat`, `thunderstormDamageThreat`, `flashFloodDetection`, `flashFloodDamageThreat`, `waterspoutDetection`, `eventMotionDescription` — under NWS key names, element 0 verbatim, only the keys sent; `null` when none were. `content[]` renders each non-empty one (`**Office:**`, `**NWS headline:**`, `**VTEC:**`, `**Hazard tags:**`).

**Decision:** `office` comes from the WMO header, not the AWIPS identifier. The AWIPS suffix is a product location code (`CWFALU` is Anchorage's marine forecast for the Aleutians), wrong for about two in five active alerts, and the VTEC office is absent on Special Weather Statements and Air Quality Alerts; the WMO centre is on every alert and agrees with the VTEC office wherever both appear. The rest of `parameters` (`BLOCKCHANNEL`, `EAS-ORG`, WEA text, `expiredReferences`, `eventEndingTime`) is not surfaced.

Also includes `affectedZones`, each entry a `code` plus its NWS `type` (`forecast`, `county`, or `fire`). `forecast` entries chain into `nws_get_zone_forecast`; a `fire` entry is a segment of its office's Fire Weather Planning Forecast, reached with `nws_get_office_discussion` (`office` from the alert's `office` field, `product_type: "FWF"`, `sections: [<zone code>]`). Every type is a valid value for this tool's own `zone` filter. Empty array when no alerts match -- this is good news, not an error.

In `content[]`, `description` and `instruction` (under its `**Recommended Actions:**` label) each render in a fenced `text` block built with `markdown().codeBlock(value, 'text')`, so a CommonMark parse returns the stored string plus a trailing newline: NWS hard-wraps both, and bare Markdown would turn `* WHAT...` lines into list items and fold wrapped lines together. The fence grows past any backtick run in the text. `structuredContent` carries both strings unchanged.

**Error modes:**
- A `point` search whose 500 outlives the retry budget -> ServiceUnavailable naming the point, with a `data.recovery.hint`: the same open-ocean points that 500 at `/points` also 500 at `/alerts/active?point=` (e.g. `25,-70`, `22,-65`, `30,-70`), so a point at sea should search by marine `region` (e.g. `AT`) or a marine `area`/`zone` filter instead; on land, a later retry may succeed. An exhausted 500 on a search without `point` keeps the baseline message.
- A `point` outside NWS coverage (e.g. `10,10`) -> NWS answers 400 `InvalidParameter` naming `point`, which fails as `invalid_point` (ValidationError, notice) with a message naming the point and a recovery toward a location NWS covers; `data` keeps `url` and `status: 400`. One request, no retry. A 400 naming another parameter, or of another problem type, passes through unchanged.

---

### `nws_get_alert`

Fetches one alert message by ID. `nws_search_alerts` returns each alert's `references[].identifier`, but an active-alert search never returns a message that a later update or cancellation replaced; this tool reaches those.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `alert_id` | string | Yes | Alert message ID: the `id` of an alert from `nws_search_alerts`, or a `references[].identifier`. Surrounding whitespace is trimmed; case is not folded, because NWS answers an altered-case ID with 404. |

**API endpoint:** `GET /alerts/{id}` -- one GeoJSON Feature, parsed by the same `parseAlert()` as a search result. NWS serves current and superseded messages for about 7 days after they are sent (a 200 can be CDN-cached for up to 24 hours). Superseded messages also carry `replacedBy`/`replacedAt`, which are not surfaced.

**Returns:** `{ alert }`, the per-alert object and markdown block `nws_search_alerts` returns (shared in `src/mcp-server/tools/alert-output.ts`). The message's own `references` run newest first, so a revision chain is walked one call per message, and every reference sharing the newest `sent` is an immediate predecessor (an update can merge several earlier segments); `references[0]` is one of them.

**Error modes:**
- A malformed ID, or an NWS 404 on `/alerts/{id}` -> `alert_not_found` (NotFound, notice). A malformed ID fails before any request. NWS answers a fabricated ID and one past its retention with the same `InvalidAlert` problem, so the two are indistinguishable. An exhausted 5xx stays a baseline ServiceUnavailable.

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

**Returns:** Station name and ID, observation timestamp, station time zone, plus measured values: `temperature`, `dewpoint`, `windSpeed`, `windDirection`, `windGust`, `barometricPressure`, `visibility`, `relativeHumidity`, `heatIndex`, `windChill`, `precipitationLastHourMm`, `precipitationLast3HoursMm`, `precipitationLast6HoursMm`, `textDescription` (e.g., "Mostly Cloudy"), `cloudLayers`. Values include units. Some fields may be null if the station doesn't report that metric (common for windGust, heatIndex, windChill). Temperature, dewpoint, heat index, and wind chill keep one decimal (hourly METARs carry tenths; heat index and wind chill are NWS-computed floats), and `format()` renders that Celsius value with the °F converted from it (`47°F (8.3°C)`, `63°F (17°C)`); wind, direction, pressure, visibility, humidity, and cloud base are integers. A gust or direction reported without a sustained speed renders with the speed marked not reported (`sustained not reported, gusts 27 mph (44 km/h)`, `180°, sustained not reported`); wind renders as not available only when no component was reported.

Precipitation amounts are the decoded METAR groups, in mm at NWS's 0.1 mm: the 1-hour P group, and the 3- or 6-hour 6-group on the hourly reports nearest 03/09/15/21 and 00/06/12/18 UTC. Two encodings drive the field descriptions and the text. A `0` is a trace (METAR `P0000` / `60000`, under 0.01 in), never a measured dry hour, and renders `Trace`. A `null` is the normal dry value: METAR omits the P group when nothing fell, and 5-minute records carry no amount (they omit the 1- and 6-hour keys, which parse as null). `format()` shows inches to two decimals beside mm, which round-trips the METAR hundredths (`1 h: 0.13 in (3.3 mm), 3 h: 0.24 in (6.1 mm)`).

**Decision:** `presentWeather` is not returned. `textDescription` already names every element it carries, intensity and modifier included (`RA BR` → "Rain and Fog/Mist").

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
| `limit` | number | No | Observations per page (default 24; schema ceiling 10000), newest first. A page holds at most 100: a larger first-page limit is served as 100 and reported through `requestedLimit`/`effectiveLimit`. Sent upstream as the applied limit + 1 (101 at most). |
| `cursor` | string | No | Opaque continuation token from a previous response's `nextCursor`. Omit for the first page. It carries the window, so `start`, `end`, and `limit` shape the first page only. |

**API flow:** `GET /stations/{id}` and `GET /stations/{id}/observations?limit=&start=&end=` in parallel, classified station-first.

**Paging is upstream**, unlike the other paged tools: a station's history has no bounded collection to fetch and window locally. The tool mints its own cursor with `encodeCursor` (`@cyanheads/mcp-ts-core/utils`), carrying the first page's `start` and applied `limit`, with the oldest returned timestamp as the next `end`. NWS treats `end` as exclusive, so each page continues from just before the oldest observation of the one before it, and pages neither repeat nor skip an observation. Every list request asks NWS for one record past the page; `truncated`, `cap`, `nextCursor`, and the notice appear only when that extra record comes back, meaning older observations remain in the window. The extra record is never returned and is the next page's first, so a window holding exactly `limit` observations ends in one request with no cursor. The cursor carries the applied limit (its own `limit <= 100` check stays).

**Decision:** NWS's own `pagination.next` is not passed through. It drops `limit`, `start`, and `end`, it appears on every non-empty page including the last, and a cursor with a malformed timestamp returns a 500.

**Returns:** `stationId` (uppercased), `stationName`, `timeZone` (null when unknown), and `observations`, newest first, each carrying the `nws_get_observations` measurement fields with the same rounding: `timestamp`, `textDescription`, `temperatureC`, `dewpointC`, `windSpeedKmh`, `windDirectionDeg`, `windGustKmh`, `barometricPressurePa`, `visibilityM`, `relativeHumidityPct`, `heatIndexC`, `windChillC`, `precipitationLastHourMm`, `precipitationLast3HoursMm`, `precipitationLast6HoursMm`, `cloudLayers`. A measurement the station did not report is `null`, never 0 (a precipitation `0` is a reported trace). Enrichment carries `shown`, plus `truncated`, `cap`, and `nextCursor` when older observations remain, `requestedLimit`/`effectiveLimit` when the limit exceeded the page cap, and a `notice` for a clamped limit, remaining observations, or an empty window. `format()` renders one dual-unit table row per observation.

**Error modes:**
- A `station_id` that is not a plain alphanumeric token, or one NWS has no station record for -> `station_not_found` (NotFound). NWS answers an unknown station's observation list with 200 and an empty collection, so the station record's 404 decides, even when the list came back 200.
- `start` or `end` not an ISO 8601 date-time with seconds (at most six fractional digits) and an offset, a date that does not exist (e.g. `2026-02-30`), or `start` not before `end` -> `invalid_time_window` (ValidationError), before any request. NWS answers a date-only value or a seventh fractional digit with a 400 and a calendar-invalid one with a 500.
- A malformed cursor, or one whose decoded window fails the same timestamp checks -> `-32602 InvalidParams` (`invalid_cursor`), before any request. As on the other paged tools, not a declared reason.
- A valid station with no observations in the window is a success: empty `observations` and a notice naming the ~7-day retention.

---

### `nws_find_stations`

Finds weather observation stations near a location. Use to discover station IDs, compare available stations, or find the closest reporting station. Results sorted by proximity.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `latitude` | number | Yes | Center latitude for proximity search. |
| `longitude` | number | Yes | Center longitude for proximity search. |
| `limit` | number | No | Stations per page (default 10; schema ceiling 10000). A page holds at most 50: a larger first-page limit is served as 50 and reported through `requestedLimit`/`effectiveLimit`. The API may return up to ~70 stations for a grid cell. |
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
| `office` | string | Yes | Product location code of 2–3 letters or digits, usually the 3-letter WFO code (e.g., "SEW"), returned as the `office` field by `nws_get_forecast`. Some offices file a product under other codes: Anchorage files its ZFP under "AER" (Anchorage East) and "ALU" (Anchorage West), not "AFC"; San Juan files its ZFP under "PR" and Guam its SPS under "PQ1". |
| `product_type` | string | No | `AFD` (default), `HWO`, `ZFP`, `SPS`, or `FWF` (Fire Weather Planning Forecast). |
| `sections` | string[] | No | Sections to return instead of the whole product: AFD section names (case- and spacing-insensitive, e.g. "AVIATION") or zone codes for ZFP/HWO/SPS/FWF (e.g. "WAZ315"; a code inside a range such as `FLZ076>078`, or on a multi-prefix line such as `IDZ001-WAZ037-`, selects that segment; an outline row's `name` verbatim also works). At most 100 entries; blank entries behave as omitted. |

**API endpoints (two-hop):**

1. `GET /products/types/{product_type}/locations/{office}` — lists products, newest first; `@graph[0]` is the latest
2. `GET /products/{id}` — retrieves full product text

**DX trap:** An unknown office returns HTTP 200 with an empty `@graph`, not a 404. Detect the empty list and throw a `no_products` error with recovery instructions. The message is per product type: SPS and HWO are episodic and commonly empty (recovery: retry with AFD), while an empty AFD or ZFP list for a valid office names the location-code case, since some offices file a product under other codes (Anchorage's ZFP under "AER" or "ALU", San Juan's under "PR"). The ZFP recovery names those codes; the AFD recovery sends the caller to confirm the WFO code from `nws_get_forecast`, since no office files its AFD under another code. FWF is filed only under WFO codes, and not by every office (AFC, AFG, AJK, GUM, and PPG file none), so an empty FWF list for a valid office says the office has no FWF on file, names no alternate code, and its recovery points to AFD or to the office in a fire weather alert's `office` field.

**Fire zones:** an FWF carries the office's `.DISCUSSION` in its header and one `$$`-terminated UGC segment per fire weather zone line, so the outline and `sections` work on it unchanged, ranges included (`NDZ012` selects BIS's `NDZ003>005-011>013-` segment). This is the forecast route for an alert's `affectedZones` entry typed `fire`: `office` from the alert's `office` field, `product_type: "FWF"`, `sections: [<zone code>]`. Most FWFs exceed the 24,000-byte budget and come back outlined.

**Returns:** `issuanceTime`, `issuingOffice`, `productName`, `productCode`, `wmoCollectiveId`, plus `productText` (the whole product, or the product header, the selected sections, and the product's closing lines when `sections` is given) or, instead of it, `outline`. In `content[]`, the heading and metadata lines are Markdown and `productText` follows in one `text` code block built with `markdown().codeBlock()`, whose backtick fence is at least three backticks and one longer than the longest backtick run in the text, so a CommonMark client keeps NWS's fixed-width columns and indented lines verbatim; the block's literal is `productText` plus a final newline. An outline renders as a Markdown list with no code block.

**Bounded output:** an AFD splits at its `.NAME...` header lines; ZFP, HWO, SPS, and FWF split into `$$`-terminated UGC segments keyed by every zone the UGC line expands to. When the whole response would exceed 24,000 bytes on either surface (`structuredContent` JSON or `content[]` text) and the product has at least two sections, `productText` is replaced by `outline`, one row per section, largest first: `name` (the AFD section name, or a segment's zone codes as issued with ranges as `NNN>MMM`), `label` (a segment's first area-name line; absent for AFD sections), and `bytes` (UTF-8 size). A `notice` names a worked re-call with `sections` for the largest section that fits with the header, and states the header-and-closing-lines byte count a selection adds to the listed sizes. `sections` returns the header, every matching section verbatim in product order and never cut, then the closing lines after the last section (forecaster credits, links), on a product of any size, with a `notice` stating how many of how many sections came back. A product under budget without `sections`, or with fewer than two sections at any size, returns whole. The partition parser is `src/services/nws/product-sections.ts`.

**Error mode `unknown_section`** (ValidationError, notice): a `sections` entry that matches no section fails with the unmatched and available names in the message and in `data.unmatched` and `data.available`; a product with no sections says there is nothing to select.

---

### `nws_get_zone_forecast`

Fetches the text-based forecast for an NWS forecast zone (land or marine). Returns named periods (e.g., "Today", "Tonight") with narrative text from local forecasters. Completes the alert-to-forecast chain — `nws_search_alerts` returns zones in `affectedZones` as `code` + `type`, and `nws_find_stations` returns `forecastZone`. Only `affectedZones` entries typed `forecast` resolve here; `county` zones have no text forecast product upstream. A `fire` zone's forecast is its segment of the office's Fire Weather Planning Forecast, served by `nws_get_office_discussion` (`office` from the alert's `office` field, `product_type: "FWF"`, `sections: [<zone code>]`); most fire codes have no forecast-zone record and fail here as `zone_not_found`, whose message and recovery name that route, and a fire code that is also a public zone code (`NDZ040`) returns the public zone's forecast instead.

**Input:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `zone_id` | string | Yes | Forecast zone code (e.g., "WAZ315", or a marine zone such as "PZZ251"). Returned by `nws_get_forecast` (`forecastZone`), `nws_find_stations` (`forecastZone`), and `nws_search_alerts` (the `code` of an `affectedZones` entry with `type: "forecast"`). |

**API endpoint:** `GET /zones/forecast/{zone_id}/forecast`

Failure modes, keyed on the 404 problem-document `type`:

- `InvalidZone`, or no body -> `zone_not_found` (county codes `XXC###` land here — use the forecast zone code `XXZ###`).
- `MarineForecastNotSupported` -> `marine_forecast_unsupported`. Marine forecast zones have zone records and appear in marine alerts' `affectedZones` typed `forecast`, but text forecast availability varies across them: offshore zones answer `MarineForecastNotSupported`, coastal zones on `AMZ`/`ANZ`/`GMZ`/`PHZ`/`PZZ` serve a text forecast, and coastal `LCZ`/`LEZ`/`LHZ`/`LMZ`/`LOZ`/`LSZ`/`SLZ`/`PMZ`/`PSZ` and most `PKZ` zones answer `NotFound`.
- `NotFound` -> ambiguous: NWS answers this way both for a valid zone with no text product (all `PRZ`/`VIZ` zones, many Alaska zones, the coastal marine zones above) and for a made-up zone with an unknown state prefix (`XXZ123`). A single no-retry probe of `GET /zones/forecast/{zone_id}` settles it: 200 -> the record's `type` decides (`coastal` or `offshore` -> `marine_forecast_unsupported`, with `data: { zoneId, reason }` and no point; `public` or type-less -> `zone_forecast_unavailable`), 404 -> `zone_not_found`.
- A 500 that outlives the retry budget (some Alaska, Guam, and Northern Mariana zones answer 500 `UnexpectedProblem` on every attempt) takes the same probe, except that a marine record keeps the original ServiceUnavailable (`data.status: 500`, no reason), since a 500 says nothing about a coastal zone's product. A 501, a gateway status (502–504), and every other failure surface unchanged.
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
| **Coverage** | US states, territories, and adjacent marine areas only. Point forecasts are land-only: marine areas get alerts, and nearshore gridded cells also stations and observations. Zone text forecast availability varies across marine zones. |
| **Observation lag** | Station data lags ~20 minutes due to upstream QC (MADIS). |
| **Grid caching** | `/points` responses (grid cell mapping) change infrequently. Cache for hours. |

### API Quirks

- **No geocoding.** The API is coordinates-only. The server should require lat/lon from the LLM. Adding internal geocoding (Census Bureau or Nominatim) is a nice-to-have but adds a dependency for marginal gain -- most LLMs can provide coordinates when asked.
- **No `limit` or cursor param on alerts.** The `/alerts/active` endpoints don't support a `limit` query parameter (returns 400) and offer no upstream cursor. The service fetches and filters the whole active collection; `limit` and `cursor` window that array locally, with a token the tool mints itself so it can carry the query's filters (see `nws_search_alerts`).
- **Hourly forecast = 156 periods.** The hourly endpoint returns 7 days of hourly data. The handler windows returned periods to 48 so `structuredContent` and `content[]` carry the same bounded set -- the pre-page total and a truncation notice are surfaced via enrichment, and `nextCursor` reaches the rest.
- **Continuation is local to one fetch.** `nws_get_forecast`, `nws_find_stations`, and `nws_search_alerts` re-fetch their collection on every call and cache nothing but `/points` grid resolution, so consecutive pages are contiguous within a single response, not across separate calls. Harmless for the near-static station registry, and near-harmless for forecasts (reissued a few times a day); the active-alert set churns continuously, so a `nws_search_alerts` page 2 is a second, independent snapshot. `nws_get_observation_history` is the exception: it pages upstream with a time-keyed cursor that continues from just before the previous page's oldest observation, so its pages do continue across calls (see its section).
- **`/alerts/active` repeats alerts within one response.** NWS emits some alerts twice in a single fetch, byte-identical in `id`, `sent`, `event`, and `areaDesc` — a multi-zone Air Quality Alert from one office is a reliable shape. The service collapses them on `id`, keeping the first occurrence, in `NwsService.searchAlerts()` on the raw feature array. That placement is deliberate: it sits ahead of both the event filter and the tool's page window, so no count is inflated and a duplicate cannot straddle a page boundary. Note this is a *different* phenomenon from the cross-call drift above — within one fetch an `id` now appears at most once, so the same `id` arriving on two pages of a page walk means the active set moved between calls.
- **Observation units are metric.** Temperature in Celsius, wind in km/h, pressure in Pa, precipitation in mm. Convert to a readable format in `format()` (F/C with both shown, mph, inHg/hPa, in/mm).
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

`nws_get_observation_history` reports `shown` and no `totalCount`, because NWS gives no total for a time window. A page followed by older observations in the window carries `truncated: true` with `cap` and a `nextCursor`; that, not `totalCount > shown`, is its continuation signal.

`nws_find_stations`, `nws_search_alerts`, and `nws_get_observation_history` serve a first-page `limit` past the page cap as the cap and name the clamp with two more enrichment fields: `requestedLimit` (what the caller asked for) and `effectiveLimit` (the applied page size, which every cursor carries). They appear only when the limit exceeded the cap, and the `notice` then opens with the clamp sentence. The schema rejects only `limit` above 10000, below 1, or non-integer, as `invalid_arguments`. A `limit` sent with a `cursor` is ignored and discloses nothing; on `nws_search_alerts`, so are the filter inputs sent with a cursor that carries its query.

### Blank optional inputs

Form-based clients send every optional field they display, empty ones as `""` or `[]`. A blank or whitespace-only optional string, an empty array, and an `event` array of nothing but blank terms are treated as omitted: left off the upstream request and out of `appliedFilters`. A blank enum (`region_type`, `status`, `product_type`) maps to unset before the enum validates, so `status` and `product_type` take their defaults; the advertised schemas are unchanged. Real values keep every check (mutual exclusion, `invalid_area_code`, `invalid_point`, `invalid_zone`, `invalid_time_window`), and a blank `station_id` with no coordinates is `missing_input`.

**Decision:** blanks were once rejected (`blank_location_filter`, `empty_filter_array`, `blank_station_id`) so a blank could not silently widen a search, which failed every form that fills one filter and leaves the rest empty. The widening stays visible without the rejection: `appliedFilters` echoes only the filters applied, and `nws_get_observations` names the station it served.

### Advertised input patterns

**Decision:** the lexical shape of an identifier input (alert area, point, and zone codes; station IDs; history `start`/`end`; office and zone codes; alert IDs) is advertised in the tool's JSON Schema as a `pattern`, so a schema-driven client can build or pre-check a value. Each pattern admits the raw forms the handler normalizes (any case, surrounding whitespace, blank on optional fields), and keeps whitespace runs unambiguous so a client's regex engine matches in linear time. Rejection stays handler- and service-owned: a Zod `.regex()` would reject before the handler as `-32602 invalid_arguments` and replace the declared reasons (`invalid_zone`, `invalid_area_code`, `invalid_point`, `invalid_time_window`, `station_not_found`, `no_products`, `zone_not_found`, `alert_not_found`) and their recovery hints.

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
