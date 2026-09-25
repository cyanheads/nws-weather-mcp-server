#!/usr/bin/env node
/**
 * @fileoverview nws-weather-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { alertTypesResource } from '@/mcp-server/resources/definitions/index.js';
import {
  findStationsTool,
  getForecastTool,
  getObservationsTool,
  getOfficeDiscussionTool,
  getZoneForecastTool,
  listAlertTypesTool,
  searchAlertsTool,
} from '@/mcp-server/tools/definitions/index.js';
import { initNwsService } from '@/services/nws/nws-service.js';

await createApp({
  name: 'nws-weather-mcp-server',
  title: 'nws-weather-mcp-server',
  tools: [
    getForecastTool,
    searchAlertsTool,
    getObservationsTool,
    findStationsTool,
    listAlertTypesTool,
    getOfficeDiscussionTool,
    getZoneForecastTool,
  ],
  resources: [alertTypesResource],
  // No tool gates on `ctx.requestInput`, so nothing here needs a session to
  // round-trip through. Declared in source rather than left to the schema
  // default (`auto`, which resolves to stateful); `MCP_SESSION_MODE` still
  // wins when it carries a value, and `.env.example`, the Dockerfile, and the
  // README environment table all name the same value.
  sessionMode: 'stateless',
  instructions:
    'Use the nws_* tools for real-time US weather data from the National Weather Service: forecasts, active alerts, current observations, station discovery, forecast office discussions, and zone-level text forecasts. Coverage is the 50 states, US territories, and adjacent marine areas, but point and zone forecasts are land-only — marine areas get alerts, plus stations and observations near the coast; the API does not geocode, so resolve place names to latitude/longitude before calling. Typical chain: nws_get_forecast → office code for nws_get_office_discussion (AFD for forecaster reasoning), forecastZone for nws_get_zone_forecast (zone text periods), or affectedZones from nws_search_alerts for nws_get_zone_forecast.',
  // Public catalog — serve the full landing page inventory regardless of auth mode.
  landing: { requireAuth: false },
  // The tool and resource inventory is fixed at process start — nothing
  // registers or retires a definition at runtime — so a 2026-07-28 client may
  // hold the discovery results for an hour. Live weather is served by
  // tools/call, which is not a cacheable operation.
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' },
  },
  setup() {
    initNwsService();
  },
});
