# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.9.1](changelog/0.9.x/0.9.1.md) — 2026-08-25

mcp-ts-core ^0.12.3 adopts SDK v2: the server now also speaks MCP protocol revision 2026-07-28, tool inputs are strict, outputSchema declares the error envelope, and discovery results carry one-hour cache hints; session mode settles on stateless everywhere

## [0.9.0](changelog/0.9.x/0.9.0.md) — 2026-08-13 · ⚠️ Breaking

nws_find_stations, nws_get_forecast, and nws_search_alerts unify their paging counts on totalCount/shown; nws_find_stations.totalCount changes meaning (breaking); nws_search_alerts collapses upstream-duplicate alerts

## [0.8.0](changelog/0.8.x/0.8.0.md) — 2026-08-12 · ⚠️ Breaking

affectedZones entries are now code+type objects (breaking); nws_search_alerts adds region/region_type filters and CAP message-lifecycle fields; a null alert description no longer fails the whole response

## [0.7.4](changelog/0.7.x/0.7.4.md) — 2026-08-12

nws_get_forecast, nws_find_stations, and nws_search_alerts take a cursor input and return nextCursor, reaching results past each tool's page cap instead of dropping them

## [0.7.3](changelog/0.7.x/0.7.3.md) — 2026-08-12

nws_search_alerts checks a zone's area prefix and rejects blank/empty filters instead of widening to a national search; nws_get_observations rejects a blank station_id instead of silently answering from coordinates

## [0.7.2](changelog/0.7.x/0.7.2.md) — 2026-07-02

nws_get_forecast hourly mode caps structuredContent at 48 periods (matching content[]), with the pre-cap total and a truncation notice surfaced via enrichment; whitespace-only office and zone_id inputs now fail schema validation instead of reaching the upstream lookup

## [0.7.1](changelog/0.7.x/0.7.1.md) — 2026-06-30 · 🛡️ Security

Framework maintenance — mcp-ts-core ^0.10.10 clears 8 transitive advisories (2 high, 6 moderate) across hono, vite, and js-yaml; nws_get_forecast and nws_get_office_discussion drop internal API-routing detail from their descriptions

## [0.7.0](changelog/0.7.x/0.7.0.md) — 2026-06-30

nws_search_alerts gains an optional limit input and validates point/zone locally before the upstream call; nws_get_observations classifies a nonexistent station as station_not_found instead of a raced no_observations

## [0.6.5](changelog/0.6.x/0.6.5.md) — 2026-06-21

nws_search_alerts gains a structured ends (hazard-end) field — the ISO-8601 end of the hazard window, nullable for open-ended alerts, distinct from the expires message-refresh time

## [0.6.4](changelog/0.6.x/0.6.4.md) — 2026-06-20

mcp-ts-core ^0.10.9 maintenance: devcheck gains a Dependency Specifiers step and plugin-manifest packaging checks, fresh-scaffold git guards, synced framework scripts + skills; no server behavior change

## [0.6.3](changelog/0.6.x/0.6.3.md) — 2026-06-15

Bug fixes: get_observations rounds structuredContent to match format() and drops blank textDescription; get_office_discussion distinguishes unknown office from valid-but-empty product list

## [0.6.2](changelog/0.6.x/0.6.2.md) — 2026-06-12

mcp-ts-core ^0.10.6 adoption: explicit server identity, MCPB bundle-content cleaner, packaging + antipattern lint guards, Docker healthcheck; skills synced

## [0.6.1](changelog/0.6.x/0.6.1.md) — 2026-06-02

mcp-ts-core 0.9.21: per-request log context fix, secret-stripped error URLs, fail-fast retries; skill sync + README key rename

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-05-30

WFO office discussions, zone forecasts, enrichment on forecast/observations, and observations/latest 404 fix

## [0.5.13](changelog/0.5.x/0.5.13.md) — 2026-05-30

Enrichment adoption: `nws_search_alerts` and `nws_find_stations` surface result totals, applied filters, and empty-result guidance in a typed `enrichment` block reaching both channels. `nws_find_stations` reports true pre-limit total via new `totalFound`.

## [0.5.12](changelog/0.5.x/0.5.12.md) — 2026-05-28

Framework `^0.9.6 → ^0.9.13`: HTTP 413 body cap, session-init gate, quieter 401/403/400/404 logging, GET /mcp surfaces keywords. Keywords expanded. `landing.requireAuth: false` set explicitly.

## [0.5.11](changelog/0.5.x/0.5.11.md) — 2026-05-23

Framework `^0.9.4 → ^0.9.6`. Skills synced: `maintenance` 2.4, `polish-docs-meta` 2.2, `release-and-publish` 2.5. Manifest description aligned.

## [0.5.10](changelog/0.5.x/0.5.10.md) — 2026-05-22

Framework `^0.9.1 → ^0.9.4`. `zod` added as explicit dep (peerDep change in 0.9.2). README badge layout, install buttons, Framework spotlight. New scripts: `audit:refresh`, `list-skills`, `lint:packaging`, `publish-mcp`. Skills synced. `qs` advisory cleared.
