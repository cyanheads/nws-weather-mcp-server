/**
 * @fileoverview Tool: nws_get_observation_history — pages back through a station's recent observations.
 * @module mcp-server/tools/definitions/get-observation-history
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { getNwsService } from '@/services/nws/nws-service.js';
import {
  formatCloudLayers,
  formatPressure,
  formatTemp,
  formatTimestamp,
  formatVisibility,
  formatWind,
  roundValue,
} from '../format-utils.js';

const MAX_LIMIT = 100;

/**
 * An ISO 8601 date-time with seconds and an explicit offset. NWS answers a date-only
 * value, one without seconds, or one with more than six fractional-second digits
 * with a 400, and a calendar-invalid one with a 500, so the handler validates
 * before any request goes out.
 */
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Epoch milliseconds of a well-formed, calendar-valid date-time, or undefined.
 * `Date` rolls an out-of-range component into the next unit (Feb 30 reads as
 * Mar 2), so every component is checked by round-tripping it through `Date.UTC`
 * instead of trusting a parse.
 */
function parseDateTime(value: string): number | undefined {
  const match = DATE_TIME_RE.exec(value);
  if (!match) return;
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi ||
    check.getUTCSeconds() !== s
  ) {
    return;
  }

  const [, , , , , , , fraction, sign, offsetHour, offsetMinute] = match;
  let offsetMs = 0;
  if (sign) {
    const oh = Number(offsetHour);
    const om = Number(offsetMinute);
    if (oh > 23 || om > 59) return;
    offsetMs = (sign === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  const fractionMs = fraction ? Number(`0.${fraction}`) * 1000 : 0;
  return wall + fractionMs - offsetMs;
}

/**
 * What a continuation token carries: the first page's window and page size, with
 * `end` moved to the oldest observation already returned. NWS treats `end` as
 * exclusive and observations are keyed by timestamp, so the next page starts at
 * the observation just older than the last one returned.
 */
interface HistoryWindow {
  end?: string | undefined;
  limit: number;
  start?: string | undefined;
}

/**
 * Mint the token that continues `window` from before `end`. `offset` is there only
 * because the framework's cursor shape requires it; this cursor is keyed by time.
 */
function mintCursor(window: HistoryWindow, end: string): string {
  return encodeCursor({
    offset: 0,
    limit: window.limit,
    end,
    ...(window.start ? { start: window.start } : {}),
  });
}

/**
 * Decode a continuation token back into its window. A token that is not one
 * this tool minted fails as InvalidParams (`invalid_cursor`) before any request,
 * the same way a malformed token fails inside `decodeCursor`.
 */
function readCursor(cursor: string, ctx: Context): HistoryWindow {
  const { limit, end, start } = decodeCursor(cursor, ctx);
  const endMs = typeof end === 'string' ? parseDateTime(end) : undefined;
  const startMs = typeof start === 'string' ? parseDateTime(start) : undefined;
  const valid =
    Number.isInteger(limit) &&
    limit <= MAX_LIMIT &&
    endMs !== undefined &&
    (start === undefined || (startMs !== undefined && startMs < endMs));
  if (!valid) {
    throw invalidParams(
      'Invalid pagination cursor. The cursor may be corrupted or from a different tool.',
      {
        cursor,
        reason: 'invalid_cursor',
        recovery: {
          hint: 'Omit `cursor` to start from the latest observation, or pass the `nextCursor` from the previous response unchanged.',
        },
      },
    );
  }
  return { limit, end: end as string, start: start as string | undefined };
}

/** Reduce a blank or whitespace-only optional string to unset (issue #46). */
function unsetIfBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The caller's window in words, for a notice. */
function describeWindow(start: string | undefined, end: string | undefined): string {
  if (start && end) return `between ${start} and ${end}`;
  if (start) return `since ${start}`;
  return `before ${end}`;
}

/** A table cell for a value the station did not report. */
const MISSING = '—';

export const getObservationHistoryTool = tool('nws_get_observation_history', {
  description:
    "Get a station's recent observation history, newest first — the trend behind the single latest reading nws_get_observations returns (is pressure falling, is the wind picking up). NWS keeps about the last 7 days per station, and a busy airport station reports as often as every 5 minutes, so a day can run past 100 observations: narrow with start (inclusive) and end (exclusive), and page back to older observations with nextCursor. Takes a station ID; use nws_find_stations to find one near a coordinate.",
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Station ID is malformed or does not exist in the NWS network',
      recovery: 'Use nws_find_stations to discover valid station IDs near a coordinate.',
      severity: 'notice',
      // Raised by the NWS service layer, which rejects a malformed ID before any
      // request and classifies the station record's 404 first; the framework fills the hint.
      thrownBy: 'service',
    },
    {
      reason: 'invalid_time_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start or end is not a valid ISO 8601 date-time with seconds and an offset, or start is not before end',
      recovery:
        'Pass start and end as ISO 8601 date-times with seconds and an offset (e.g., "2026-09-30T14:00:00Z" or "2026-09-30T07:00:00-07:00") with start before end, or omit both for the latest observations.',
      severity: 'notice',
    },
  ],

  input: z.object({
    station_id: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Observation station ID (e.g., "KSEA"), case-insensitive. Use nws_find_stations to discover station IDs near a coordinate.',
      ),
    start: z
      .string()
      .optional()
      .describe(
        'Earliest observation time to include (inclusive), as an ISO 8601 date-time with seconds and an offset (e.g., "2026-09-30T00:00:00Z" or "2026-09-29T17:00:00-07:00"). Omit to reach back as far as NWS keeps, about 7 days.',
      ),
    end: z
      .string()
      .optional()
      .describe(
        'Time to stop before (exclusive), in the same format as start. Omit to start from the most recent observation.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(24)
      .describe(
        `Observations per page (1-${MAX_LIMIT}), newest first. When a page fills the limit, pass its nextCursor back as cursor for older observations.`,
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous response's nextCursor. Omit for the first page. It carries that query's start, end, and limit, so those inputs apply to the first page only. Each page continues from just before the oldest observation of the one before it, so pages neither repeat nor skip an observation.",
      ),
  }),

  output: z.object({
    stationId: z.string().describe('Observation station ID, uppercased'),
    stationName: z.string().describe('Station name'),
    timeZone: z.string().nullable().describe('Station time zone when known'),
    observations: z
      .array(
        z
          .object({
            timestamp: z.string().describe('Observation time (ISO 8601)'),
            textDescription: z
              .string()
              .describe('Conditions summary (e.g., "Mostly Cloudy"); empty when not reported'),
            temperatureC: z.number().nullable().describe('Temperature in Celsius'),
            dewpointC: z.number().nullable().describe('Dewpoint in Celsius'),
            windSpeedKmh: z.number().nullable().describe('Wind speed in km/h'),
            windDirectionDeg: z.number().nullable().describe('Wind direction in degrees (0-360)'),
            windGustKmh: z.number().nullable().describe('Wind gust in km/h'),
            barometricPressurePa: z.number().nullable().describe('Barometric pressure in Pascals'),
            visibilityM: z.number().nullable().describe('Visibility in meters'),
            relativeHumidityPct: z
              .number()
              .nullable()
              .describe('Relative humidity in percent (0-100)'),
            heatIndexC: z.number().nullable().describe('Heat index in Celsius'),
            windChillC: z.number().nullable().describe('Wind chill in Celsius'),
            cloudLayers: z
              .array(
                z
                  .object({
                    amount: z.string().describe('Cloud cover (e.g., "FEW", "SCT", "BKN", "OVC")'),
                    baseM: z.number().nullable().describe('Cloud base height in meters'),
                  })
                  .describe('Single cloud layer with cover amount and base height'),
              )
              .describe('Cloud layer information'),
          })
          .describe('One observation; a measurement the station did not report is null, never 0'),
      )
      .describe('Observations in the window, newest first'),
  }),

  // Result-set context for the agent. NWS reports no total for a window, so the
  // page reports what it returned and whether it filled the limit — no totalCount.
  enrichment: {
    shown: z.number().describe('Number of observations returned in this page'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when this page filled the limit and older observations in the window may remain; continue with nextCursor.',
      ),
    cap: z.number().optional().describe('The page limit this page filled, when truncated is true'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Opaque token for the next, older page — pass it back as cursor. Present only when this page filled the limit; omitted on the last page.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the window held no observations (NWS keeps about the last 7 days), or when this page filled the limit and older observations may remain.',
      ),
  },

  enrichmentTrailer: {
    shown: { label: 'Returned' },
    truncated: { label: 'Page Full' },
    cap: { label: 'Page Limit' },
    nextCursor: { label: 'Next Cursor' },
  },

  async handler(input, ctx) {
    const cursor = unsetIfBlank(input.cursor);
    let window: HistoryWindow;
    if (cursor) {
      window = readCursor(cursor, ctx);
    } else {
      const start = unsetIfBlank(input.start);
      const end = unsetIfBlank(input.end);
      const startMs = start === undefined ? undefined : parseDateTime(start);
      const endMs = end === undefined ? undefined : parseDateTime(end);
      for (const [field, value, ms] of [
        ['start', start, startMs],
        ['end', end, endMs],
      ] as const) {
        if (value !== undefined && ms === undefined) {
          throw ctx.fail(
            'invalid_time_window',
            `${field} "${value}" is not a valid ISO 8601 date-time with seconds and an offset (e.g., "2026-09-30T14:00:00Z"), or names a date that does not exist.`,
            { [field]: value },
          );
        }
      }
      if (startMs !== undefined && endMs !== undefined && startMs >= endMs) {
        throw ctx.fail(
          'invalid_time_window',
          `start "${start}" is not before end "${end}"; the window would hold no observations.`,
          { start, end },
        );
      }
      window = { start, end, limit: input.limit };
    }

    const result = await getNwsService().getObservationHistory(
      { stationId: input.station_id, ...window },
      ctx,
    );

    const observations = result.observations.map((obs) => ({
      timestamp: obs.timestamp,
      textDescription: obs.textDescription,
      temperatureC: roundValue(obs.temperature.value),
      dewpointC: roundValue(obs.dewpoint.value),
      windSpeedKmh: roundValue(obs.windSpeed.value),
      windDirectionDeg: roundValue(obs.windDirection.value),
      windGustKmh: roundValue(obs.windGust.value),
      barometricPressurePa: roundValue(obs.barometricPressure.value),
      visibilityM: roundValue(obs.visibility.value),
      relativeHumidityPct: roundValue(obs.relativeHumidity.value),
      heatIndexC: roundValue(obs.heatIndex.value),
      windChillC: roundValue(obs.windChill.value),
      cloudLayers: obs.cloudLayers.map((l) => ({
        amount: l.amount,
        baseM: roundValue(l.base.value),
      })),
    }));

    ctx.enrich({ shown: observations.length });

    // A page short of the limit is the last one. A full page continues from its
    // oldest observation, unless that observation sits on `start` itself, where
    // the window has nothing older left to give.
    const oldest = observations.at(-1)?.timestamp;
    const startMs = window.start ? parseDateTime(window.start) : undefined;
    const oldestMs = oldest ? parseDateTime(oldest) : undefined;
    const windowExhausted = startMs !== undefined && oldestMs !== undefined && oldestMs <= startMs;
    if (oldest && observations.length === window.limit && !windowExhausted) {
      ctx.enrich({ nextCursor: mintCursor(window, oldest) });
      ctx.enrich.truncated({
        shown: observations.length,
        cap: window.limit,
        guidance: `Returned ${observations.length} observations, the page limit; older observations in this window may remain. Pass nextCursor back as cursor to continue from before ${oldest}.`,
      });
    } else if (observations.length === 0) {
      ctx.enrich.notice(
        cursor
          ? `No observations remain ${describeWindow(window.start, window.end)} — that is the end of ${result.stationId}'s history in this window. NWS keeps about the last 7 days of a station's observations.`
          : window.start || window.end
            ? `No observations from ${result.stationId} ${describeWindow(window.start, window.end)}. NWS keeps about the last 7 days of a station's observations, so move the window inside that range, or omit start and end for the latest.`
            : `${result.stationId} has reported no observations in the ~7 days NWS keeps. Use nws_find_stations to pick an active station nearby.`,
      );
    }

    return {
      stationId: result.stationId,
      stationName: result.stationName,
      timeZone: result.timeZone,
      observations,
    };
  },

  format: (result) => {
    const lines = [
      `## Observation History — ${result.stationName} (${result.stationId})`,
      `**Station time zone:** ${result.timeZone ?? 'Not available'}`,
      '',
    ];

    if (result.observations.length === 0) {
      lines.push('No observations in this window. See the notice below.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push(
      `${result.observations.length} observation${result.observations.length === 1 ? '' : 's'}, newest first. ${MISSING} = not reported.`,
      '',
      '| Time | Conditions | Temperature | Dewpoint | Humidity | Wind | Pressure | Visibility | Heat Index | Wind Chill | Clouds |',
      '|:-----|:-----------|:------------|:---------|:---------|:-----|:---------|:-----------|:-----------|:-----------|:-------|',
    );

    for (const o of result.observations) {
      const cells = [
        formatTimestamp(o.timestamp, result.timeZone),
        o.textDescription || MISSING,
        formatTemp(o.temperatureC) ?? MISSING,
        formatTemp(o.dewpointC) ?? MISSING,
        o.relativeHumidityPct != null ? `${o.relativeHumidityPct}%` : MISSING,
        o.windSpeedKmh != null
          ? formatWind(o.windSpeedKmh, o.windDirectionDeg, o.windGustKmh)
          : MISSING,
        o.barometricPressurePa != null ? formatPressure(o.barometricPressurePa) : MISSING,
        o.visibilityM != null ? formatVisibility(o.visibilityM) : MISSING,
        formatTemp(o.heatIndexC) ?? MISSING,
        formatTemp(o.windChillC) ?? MISSING,
        o.cloudLayers.length > 0 ? formatCloudLayers(o.cloudLayers) : MISSING,
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
