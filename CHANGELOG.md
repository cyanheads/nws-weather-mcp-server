# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
