#!/usr/bin/env node
/**
 * @fileoverview nws-weather-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { initNwsService } from '@/services/nws/nws-service.js';
import { alertTypesResource } from '@/mcp-server/resources/definitions/index.js';
import {
  findStationsTool,
  getForecastTool,
  getObservationsTool,
  listAlertTypesTool,
  searchAlertsTool,
} from '@/mcp-server/tools/definitions/index.js';

await createApp({
  tools: [
    getForecastTool,
    searchAlertsTool,
    getObservationsTool,
    findStationsTool,
    listAlertTypesTool,
  ],
  resources: [alertTypesResource],
  setup() {
    initNwsService();
  },
});
