/**
 * @fileoverview Tool: nws_find_stations — finds nearby weather observation stations.
 * @module mcp-server/tools/definitions/find-stations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNwsService } from '@/services/nws/nws-service.js';

export const findStationsTool = tool('nws_find_stations', {
  description:
    'Find weather observation stations near a location. Returns stations sorted by proximity with distance and bearing. Use to discover station IDs for nws_get_observations.',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'out_of_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Coordinates fall outside US National Weather Service coverage',
      recovery: 'Provide coordinates within US states, territories, or adjacent marine areas.',
    },
  ],

  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Center latitude for proximity search.'),
    longitude: z.number().min(-180).max(180).describe('Center longitude for proximity search.'),
    limit: z.number().int().min(1).max(50).default(10).describe('Max stations to return (1-50).'),
  }),

  output: z.object({
    stations: z
      .array(
        z
          .object({
            stationId: z.string().describe('Station identifier (e.g., "KSEA")'),
            name: z.string().describe('Station name'),
            distanceKm: z.number().describe('Distance from query point in kilometers'),
            bearing: z.string().describe('Compass bearing from query point (e.g., "NW")'),
            elevationM: z.number().nullable().describe('Elevation in meters'),
            timeZone: z.string().describe('IANA time zone'),
            county: z.string().describe('County zone code (e.g., "WAC033")'),
            forecastZone: z.string().describe('Forecast zone code (e.g., "WAZ315")'),
          })
          .describe('Observation station record with identity, location, and zone codes'),
      )
      .describe('Nearby stations sorted by distance'),
  }),

  // Result-set context for the agent — total available stations (pre-limit), returned count,
  // and empty-result guidance.
  enrichment: {
    totalFound: z
      .number()
      .describe(
        'Total observation stations available near this location before the limit was applied',
      ),
    totalCount: z.number().describe('Number of stations returned (respects the limit parameter)'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no stations were found near the requested coordinates.'),
  },

  enrichmentTrailer: {
    totalFound: { label: 'Total Nearby' },
    totalCount: { label: 'Returned' },
  },

  async handler(input, ctx) {
    const result = await getNwsService().findStations(
      input.latitude,
      input.longitude,
      input.limit,
      ctx,
    );

    const stations = result.stations.map((s) => ({
      stationId: s.stationId,
      name: s.name,
      distanceKm: s.distance,
      bearing: s.bearing,
      elevationM: s.elevation.value != null ? Math.round(s.elevation.value) : null,
      timeZone: s.timeZone,
      county: s.county,
      forecastZone: s.forecastZone,
    }));

    ctx.enrich({ totalFound: result.totalFound, totalCount: stations.length });
    if (stations.length === 0) {
      ctx.enrich.notice(
        `No observation stations found near (${input.latitude}, ${input.longitude}). Try coordinates closer to the US mainland, territories, or adjacent marine areas.`,
      );
    }

    return { stations };
  },

  format: (result) => {
    if (result.stations.length === 0) {
      return [
        {
          type: 'text',
          text: 'No stations found near this location. See the enrichment block above for details.',
        },
      ];
    }

    const lines = [
      `## ${result.stations.length} Nearby Station${result.stations.length > 1 ? 's' : ''}\n`,
    ];

    lines.push('| Station | Name | Distance | Bearing | Elevation | Time Zone | County | Zone |');
    lines.push('|:--------|:-----|:---------|:--------|:----------|:----------|:-------|:-----|');

    for (const s of result.stations) {
      const elev = s.elevationM != null ? `${Math.round(s.elevationM)}m` : '—';
      lines.push(
        `| ${s.stationId} | ${s.name} | ${s.distanceKm} km | ${s.bearing} | ${elev} | ${s.timeZone} | ${s.county} | ${s.forecastZone} |`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
