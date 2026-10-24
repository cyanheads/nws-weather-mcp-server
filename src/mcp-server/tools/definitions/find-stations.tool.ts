/**
 * @fileoverview Tool: nws_find_stations — finds nearby weather observation stations.
 * @module mcp-server/tools/definitions/find-stations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, escapeMarkdownInline, paginateArray } from '@cyanheads/mcp-ts-core/utils';
import { getNwsService } from '@/services/nws/nws-service.js';
import {
  clampPageLimit,
  composeNotice,
  LIMIT_CEILING,
  type PageLimit,
  validatePageWindow,
} from '../page-limit.js';
import { unsetIfBlank } from '../unset-if-blank.js';

/**
 * Upper bound on stations per page. The NWS grid-stations endpoint returns the
 * whole collection in one response (~70 near a metro grid cell), so the service
 * hands back the complete distance-sorted set and this tool windows it. Stations
 * past the window are reachable through the `nextCursor` continuation token. A
 * larger `limit` is served up to this cap rather than rejected.
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
      // Caller coordinates outside coverage: a modeled outcome, logged at notice.
      severity: 'notice',
      // Raised by the NWS service layer's /points resolution with this reason,
      // not by a `ctx.fail` in this handler; the framework fills the hint.
      thrownBy: 'service',
    },
  ],

  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Center latitude for proximity search.'),
    longitude: z.number().min(-180).max(180).describe('Center longitude for proximity search.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMIT_CEILING)
      .default(10)
      .describe(
        `Max stations per page. A page holds at most ${MAX_STATIONS}; a larger limit (up to ${LIMIT_CEILING}) is served as ${MAX_STATIONS} and reported through requestedLimit and effectiveLimit. totalCount still reports every station near the point, so pass the returned nextCursor as cursor to reach the rest.`,
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
    totalCount: z
      .number()
      .describe(
        'Total observation stations available near this location before the page limit was applied — NOT the number returned in this page, which is shown. Same value on every page of one query; compare it against shown to tell whether stations were withheld.',
      ),
    shown: z.number().describe('Number of stations returned in this page'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Opaque token for the next page of stations — pass it back as `cursor`. Omitted when this is the last page.',
      ),
    requestedLimit: z
      .number()
      .optional()
      .describe(
        `The limit asked for, when it exceeded the ${MAX_STATIONS}-station page cap; absent otherwise.`,
      ),
    effectiveLimit: z
      .number()
      .optional()
      .describe(
        'The page size applied instead of requestedLimit; continued pages keep it. Absent when the limit was within the cap.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the requested limit exceeded the page cap, when no stations were found near the requested coordinates, when stations remain beyond this page, or when the supplied cursor points past the end of the list.',
      ),
  },

  enrichmentTrailer: {
    totalCount: { label: 'Total Nearby' },
    shown: { label: 'Returned' },
    nextCursor: { label: 'Next Cursor' },
    requestedLimit: { label: 'Requested Limit' },
    effectiveLimit: { label: 'Applied Limit' },
  },

  async handler(input, ctx) {
    const cursor = unsetIfBlank(input.cursor);
    if (cursor !== undefined) {
      const { offset, limit } = decodeCursor(cursor, ctx);
      validatePageWindow(
        offset,
        limit,
        cursor,
        'Omit `cursor` to restart from the nearest station, or pass the previous nextCursor unchanged.',
      );
    }
    const result = await getNwsService().findStations(input.latitude, input.longitude, ctx);

    const allStations = [...result.stations];
    // Every station near the point, before the page window (issue #14). Stays
    // constant across the pages of one query, and is deliberately a different
    // quantity from `shown`, which counts what this page returned.
    const totalCount = allStations.length;

    // A cursor carries its own page size, so only a first page's limit is held
    // to the cap; `paginateArray` applies its cap to cursor pages alone.
    const { effectiveLimit, clamp }: PageLimit = cursor
      ? { effectiveLimit: input.limit }
      : clampPageLimit(input.limit, MAX_STATIONS);
    const page = paginateArray(allStations, cursor, effectiveLimit, MAX_STATIONS, ctx);

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
      totalCount,
      shown: stations.length,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...clamp?.fields,
    });
    let pageNotice: string | undefined;
    if (totalCount === 0) {
      pageNotice = `No observation stations found near (${input.latitude}, ${input.longitude}). Points beyond the NWS forecast grid (open waters and some remote islands) have no assigned stations — try coordinates on or near the coast of a US state or territory.`;
    } else if (page.nextCursor) {
      pageNotice = `Returning ${stations.length} of ${totalCount} nearby stations. Pass nextCursor back as cursor for the next page. Stations are contiguous within one response; the list is re-fetched on every call, so a later call can window an updated registry.`;
    } else if (cursor && stations.length === 0) {
      pageNotice = `The cursor points past the end of the ${totalCount} stations near (${input.latitude}, ${input.longitude}). Call again without a cursor to restart from the nearest station.`;
    }
    const notice = composeNotice(clamp?.notice, pageNotice);
    if (notice) ctx.enrich.notice(notice);

    return { stations };
  },

  format: (result) => {
    if (result.stations.length === 0) {
      return [
        {
          type: 'text',
          text: 'No stations found near this location. See the enrichment block below for details.',
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
        `| ${escapeMarkdownInline(s.stationId)} | ${escapeMarkdownInline(s.name)} | ${s.distanceKm} km | ${escapeMarkdownInline(s.bearing)} | ${elev} | ${escapeMarkdownInline(s.timeZone)} | ${escapeMarkdownInline(s.county)} | ${escapeMarkdownInline(s.forecastZone)} |`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
