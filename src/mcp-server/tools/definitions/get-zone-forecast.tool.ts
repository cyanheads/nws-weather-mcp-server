/**
 * @fileoverview Tool: nws_get_zone_forecast — fetches the text forecast for a public forecast zone.
 * @module mcp-server/tools/definitions/get-zone-forecast
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNwsService } from '@/services/nws/nws-service.js';

export const getZoneForecastTool = tool('nws_get_zone_forecast', {
  description:
    'Get the text forecast for a public NWS forecast zone. Returns named forecast periods (e.g., "Today", "Tonight", "Monday") with detailed narrative text — the human-readable, zone-level forecast written by local forecasters. Completes the alert-to-forecast chain: nws_search_alerts returns zone codes in "affectedZones", and nws_find_stations returns them in the "forecastZone" column; use those codes here. Zone codes follow the pattern XXZ### (e.g., "WAZ315" for Western Washington lowlands). County zone codes (XXC###) are not supported — use the forecast zone code.',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'zone_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Zone code is not a valid public forecast zone or has no forecast available',
      recovery:
        'Use the "forecastZone" field from nws_get_forecast, the "forecastZone" column from nws_find_stations, or "affectedZones" from nws_search_alerts. Zone codes follow the pattern XXZ### (e.g., "WAZ315"). County codes (XXC###) are not supported.',
    },
  ],

  input: z.object({
    zone_id: z
      .string()
      .trim()
      .min(1)
      .describe(
        'NWS public forecast zone code (e.g., "WAZ315" for the Western Washington lowlands including Seattle). Returned as "forecastZone" by nws_get_forecast and nws_find_stations, or in "affectedZones" by nws_search_alerts. Format: two-letter state + "Z" + three-digit number.',
      ),
  }),

  output: z.object({
    zoneId: z.string().describe('Zone ID as provided (e.g., "WAZ315").'),
    updated: z
      .string()
      .describe('When the zone forecast was last updated (ISO 8601 with timezone offset).'),
    periods: z
      .array(
        z
          .object({
            number: z.number().describe('Period sequence number, starting at 1.'),
            name: z.string().describe('Period name (e.g., "Today", "Tonight", "Monday").'),
            detailedForecast: z
              .string()
              .describe(
                'Full narrative forecast for this period, written by local forecasters (e.g., "Partly cloudy. Highs in the upper 60s. Southwest winds 10 to 15 mph.").',
              ),
          })
          .describe('Single forecast period with name and narrative'),
      )
      .describe('Forecast periods in chronological order, typically covering 7 days.'),
  }),

  // Result-set context for the agent — period count so agents know forecast length.
  enrichment: {
    periodCount: z.number().describe('Number of forecast periods returned.'),
  },

  enrichmentTrailer: {
    periodCount: { label: 'Periods' },
  },

  async handler(input, ctx) {
    const zoneId = input.zone_id.toUpperCase();
    const result = await getNwsService().getZoneForecast(zoneId, ctx);

    ctx.enrich({ periodCount: result.periods.length });

    return {
      zoneId: result.zoneId,
      updated: result.updated,
      periods: result.periods.map((p) => ({
        number: p.number,
        name: p.name,
        detailedForecast: p.detailedForecast,
      })),
    };
  },

  format: (result) => {
    const lines = [`## Zone Forecast: ${result.zoneId}`, `**Updated:** ${result.updated}`, ''];

    for (const p of result.periods) {
      lines.push(`### ${p.number}. ${p.name}`);
      lines.push(p.detailedForecast);
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
