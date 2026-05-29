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
  listAlertTypesTool,
  searchAlertsTool,
} from '@/mcp-server/tools/definitions/index.js';
import { initNwsService } from '@/services/nws/nws-service.js';

await createApp({
  tools: [
    getForecastTool,
    searchAlertsTool,
    getObservationsTool,
    findStationsTool,
    listAlertTypesTool,
  ],
  resources: [alertTypesResource],
  instructions:
    'Use the nws_* tools for real-time US weather data from the National Weather Service: forecasts, active alerts, current observations, and station discovery. Coverage is the 50 states, US territories, and adjacent marine areas; the API does not geocode, so resolve place names to latitude/longitude before calling.',
  // Public catalog — serve the full landing page inventory regardless of auth mode.
  landing: { requireAuth: false },
  setup() {
    initNwsService();
  },
});
