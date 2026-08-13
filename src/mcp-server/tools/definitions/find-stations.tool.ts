/**
 * @fileoverview Tool: nws_find_stations — finds nearby weather observation stations.
 * @module mcp-server/tools/definitions/find-stations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { paginateArray } from '@cyanheads/mcp-ts-core/utils';
import { getNwsService } from '@/services/nws/nws-service.js';

/**
 * Upper bound on stations per page. The NWS grid-stations endpoint returns the
 * whole collection in one response (~70 near a metro grid cell), so the service
 * hands back the complete distance-sorted set and this tool windows it. Stations
 * past the window are reachable through the `nextCursor` continuation token.
 */
const MAX_STATIONS = 50;

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
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_STATIONS)
      .default(10)
      .describe(
        `Max stations per page (1-${MAX_STATIONS}). totalFound still reports every station near the point, so pass the returned nextCursor as cursor to reach the rest.`,
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous response's nextCursor. Omit for the first page. The token carries its own page size, so limit applies to the first page only. Every call re-fetches the station list, so pages are contiguous within one response; the registry changes rarely, but a later call can window an updated list.",
      ),
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
  // continuation token, and empty-result guidance.
  enrichment: {
    totalFound: z
      .number()
      .describe(
        'Total observation stations available near this location before the page limit was applied. Same value on every page of one query.',
      ),
    totalCount: z.number().describe('Number of stations returned in this page'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Opaque token for the next page of stations — pass it back as `cursor`. Omitted when this is the last page.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no stations were found near the requested coordinates, when stations remain beyond this page, or when the supplied cursor points past the end of the list.',
      ),
  },

  enrichmentTrailer: {
    totalFound: { label: 'Total Nearby' },
    totalCount: { label: 'Returned' },
    nextCursor: { label: 'Next Cursor' },
  },

  async handler(input, ctx) {
    const result = await getNwsService().findStations(input.latitude, input.longitude, ctx);

    const allStations = [...result.stations];
    // Every station near the point, before the page window (issue #14). Stays
    // constant across the pages of one query, and is deliberately a different
    // quantity from `totalCount`, which counts what this page returned.
    const totalFound = allStations.length;

    const page = paginateArray(allStations, input.cursor, input.limit, MAX_STATIONS, ctx);

    const stations = page.items.map((s) => ({
      stationId: s.stationId,
      name: s.name,
      distanceKm: s.distance,
      bearing: s.bearing,
      elevationM: s.elevation.value != null ? Math.round(s.elevation.value) : null,
      timeZone: s.timeZone,
      county: s.county,
      forecastZone: s.forecastZone,
    }));

    ctx.enrich({
      totalFound,
      totalCount: stations.length,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
    if (totalFound === 0) {
      ctx.enrich.notice(
        `No observation stations found near (${input.latitude}, ${input.longitude}). Try coordinates closer to the US mainland, territories, or adjacent marine areas.`,
      );
    } else if (page.nextCursor) {
      ctx.enrich.notice(
        `Returning ${stations.length} of ${totalFound} nearby stations. Pass nextCursor back as cursor for the next page. Stations are contiguous within one response; the list is re-fetched on every call, so a later call can window an updated registry.`,
      );
    } else if (input.cursor && stations.length === 0) {
      ctx.enrich.notice(
        `The cursor points past the end of the ${totalFound} stations near (${input.latitude}, ${input.longitude}). Call again without a cursor to restart from the nearest station.`,
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
