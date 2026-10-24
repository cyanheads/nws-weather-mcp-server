/**
 * @fileoverview Tool: nws_get_forecast — retrieves weather forecast for US coordinates.
 * @module mcp-server/tools/definitions/get-forecast
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor, escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getNwsService } from '@/services/nws/nws-service.js';
import { cToF, formatTimestamp, fToC } from '../format-utils.js';
import { composeNotice, invalidCursor, validatePageWindow } from '../page-limit.js';
import { unsetIfBlank } from '../unset-if-blank.js';

/**
 * Forecast periods per page. Applied in the handler so `structuredContent` and
 * `content[]` share the same bounded projection — the upstream hourly feed
 * carries ~156 periods (7 days), which floods context unbounded. The pre-page
 * total is surfaced via the `totalCount` enrichment field, and the periods past
 * this window are reachable through the `nextCursor` continuation token rather
 * than dropped.
 */
const MAX_PERIODS = 48;

/**
 * Grid age past which the forecast gets a stale notice. Several offices run a
 * ~12-hour forecast package cycle with gaps reaching ~16.6 h, so a 12 h bound
 * would fire in normal operation; 24 h is about twice the package cadence (the
 * ratio nws_get_observations uses against hourly reports) and means a missed
 * cycle.
 */
const STALE_UPDATE_MS = 24 * 3_600_000;

/**
 * A page of the period array. `hourly` is the mode the token was minted in;
 * a 0.11.0 token carries none, and the page then reads the `hourly` input.
 */
interface PeriodWindow {
  hourly?: boolean | undefined;
  limit: number;
  offset: number;
}

/**
 * Decode a continuation token, before any request. A token this tool could not
 * have minted fails as InvalidParams (`invalid_cursor`), the same way a
 * malformed token fails inside `decodeCursor`. The page size is held to
 * MAX_PERIODS, as `paginateArray` held it, so a forged larger limit cannot widen
 * the page. The tool mints its own token (`encodeCursor` in the handler) because
 * `paginateArray` re-mints `{offset, limit}` only, which would drop the mode.
 */
function readCursor(cursor: string, ctx: Context): PeriodWindow {
  const { offset, limit, hourly } = decodeCursor(cursor, ctx);
  validatePageWindow(
    offset,
    limit,
    cursor,
    'Omit `cursor` to start from the first period, or pass the `nextCursor` from the previous response unchanged.',
  );
  if (hourly !== undefined && typeof hourly !== 'boolean') {
    throw invalidCursor(
      cursor,
      'Omit `cursor` to start from the first period, or pass the `nextCursor` from the previous response unchanged.',
    );
  }
  return { offset, limit: Math.min(limit, MAX_PERIODS), hourly };
}

/**
 * Derive a period label from startTime when name is empty (hourly periods).
 * Renders in the forecast location's IANA zone, whatever the host TZ, so the
 * label agrees with the time range rendered below it.
 */
function periodLabel(name: string, startTime: string, timeZone: string): string {
  if (name) return name;
  const d = new Date(startTime);
  if (Number.isNaN(d.getTime())) return startTime;
  return d.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

export const getForecastTool = tool('nws_get_forecast', {
  description:
    'Get the weather forecast for a US location. Returns either named 12-hour periods (default) or hourly breakdowns.',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'out_of_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Coordinates fall outside US National Weather Service coverage',
      recovery:
        'Provide coordinates on land within US states or territories — NWS point forecasts do not cover marine areas.',
      // Caller coordinates outside coverage: a modeled outcome, logged at notice.
      severity: 'notice',
      // Raised by the NWS service layer's /points resolution with this reason,
      // not by a `ctx.fail` in this handler; the framework fills the hint.
      thrownBy: 'service',
    },
    {
      reason: 'marine_forecast_unsupported',
      code: JsonRpcErrorCode.NotFound,
      when: 'Coordinates fall in a marine area, where NWS publishes no point forecast',
      recovery:
        'Retry nws_get_forecast with coordinates on nearby land, or use nws_search_alerts (by point, or by the marine zone code in the message) for marine hazards at this location.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'no_forecast_grid',
      code: JsonRpcErrorCode.NotFound,
      when: 'Coordinates are on land in a forecast zone NWS serves no forecast grid for (e.g., interior Northern Mariana Islands)',
      recovery:
        'Use nws_search_alerts with zone set to the forecast zone code in the message for active hazards at this location; NWS publishes no point forecast here.',
      severity: 'notice',
      thrownBy: 'service',
    },
  ],

  input: z.object({
    include_amounts: z
      .boolean()
      .default(false)
      .describe(
        'Include every native quantitativePrecipitation, snowfallAmount, and iceAccumulation interval from the NWS grid. Applies to this call only, including cursor pages; units and interval strings remain as NWS sends them. Unavailable amounts are explained in notice while the forecast remains available.',
      ),
    latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees (e.g., 47.6062).'),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe('Longitude in decimal degrees (e.g., -122.3321).'),
    hourly: z
      .boolean()
      .default(false)
      .describe(
        `If true, returns hourly forecast (${MAX_PERIODS} one-hour periods per page, ~156 available) instead of 12-hour named periods (14 periods). Hourly includes dewpoint and relative humidity. Sets the mode of the first page; a cursor carries its own mode, so this is ignored when cursor is set.`,
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        `Opaque continuation token from a previous response's nextCursor, to retrieve the next ${MAX_PERIODS} periods. Omit for the first page. The token carries the mode it was issued in (hourly or 7-day), so the next page stays in that mode whatever hourly is set to. Every call re-fetches the forecast, so consecutive periods are contiguous within one response; NWS reissues forecasts through the day, so a later call can window a regenerated period array.`,
      ),
  }),

  output: z.object({
    precipitationAmounts: z
      .array(
        z
          .object({
            layer: z
              .enum(['quantitativePrecipitation', 'snowfallAmount', 'iceAccumulation'])
              .describe('Native grid amount layer name'),
            uom: z.string().nullable().describe('Native NWS layer unit, or null when omitted'),
            values: z
              .array(
                z
                  .object({
                    validTime: z.string().describe('Native ISO 8601 interval string, unchanged'),
                    value: z.number().nullable().describe('Native amount, or null when unreported'),
                  })
                  .describe('One native accumulation interval'),
              )
              .describe(
                'Every interval in this layer, including null measurements; empty when NWS publishes no intervals',
              ),
          })
          .describe('One present quantitative amount layer'),
      )
      .optional()
      .describe(
        'Present grid amount layers when requested and fetched successfully; missing layers are named in notice',
      ),
    amountsUpdateTime: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Native grid updateTime, distinct from forecast updateTime; null when omitted upstream and absent when amounts were not fetched',
      ),
    location: z
      .object({
        city: z.string().describe('City name'),
        state: z.string().describe('State name'),
        office: z.string().describe('NWS Weather Forecast Office code'),
        timeZone: z.string().describe('IANA time zone'),
        forecastZone: z.string().describe('Forecast zone code for chaining to nws_search_alerts'),
        county: z.string().describe('County zone code for chaining to nws_search_alerts'),
      })
      .describe('Resolved location metadata'),
    generatedAt: z
      .string()
      .describe(
        'When NWS generated this response (ISO 8601). It advances whenever NWS regenerates the response, even when the underlying data is unchanged; see updateTime for the data age.',
      ),
    updateTime: z
      .string()
      .nullable()
      .describe(
        'When the data this forecast was generated from was last updated (ISO 8601, as NWS sends it). A grid that stops updating keeps this time while generatedAt keeps advancing. Null when NWS omits it.',
      ),
    periods: z
      .array(
        z
          .object({
            name: z
              .string()
              .describe(
                'Period name (e.g., "Today", "Tonight"); in hourly mode, the weekday and start time in the location time zone (e.g., "Fri 6:00 AM")',
              ),
            startTime: z.string().describe('Period start (ISO 8601)'),
            endTime: z.string().describe('Period end (ISO 8601)'),
            temperature: z.number().describe('Temperature value'),
            temperatureUnit: z.string().describe('Temperature unit (F or C)'),
            windSpeed: z.string().describe('Wind speed (e.g., "10 mph")'),
            windDirection: z.string().describe('Wind direction (e.g., "NW")'),
            shortForecast: z.string().describe('Brief forecast (e.g., "Mostly Sunny")'),
            detailedForecast: z.string().describe('Full narrative forecast'),
            precipChancePct: z
              .number()
              .nullable()
              .describe('Probability of precipitation in percent (0-100)'),
            dewpointC: z.number().nullable().describe('Dewpoint in Celsius (hourly only)'),
            relativeHumidityPct: z
              .number()
              .nullable()
              .describe('Relative humidity in percent (0-100, hourly only)'),
          })
          .describe('Single forecast period with time range, conditions, and narrative'),
      )
      .describe('Forecast periods'),
  }),

  // Result-set context for the agent — shown/total period counts and mode echo
  // so agents know forecast granularity and whether the period set was capped,
  // without re-deriving from the array. generatedAt and updateTime already live
  // in output; not duplicated here.
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total forecast periods available upstream before the page window was applied — NOT the number in this page, which is shown. Compare it against shown to tell whether periods were withheld.',
      ),
    shown: z.number().describe(`Number of forecast periods in this page (at most ${MAX_PERIODS}).`),
    mode: z.string().describe('Forecast mode: "hourly" or "7-day"'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Opaque token for the next page of periods — pass it back as `cursor`; it carries this forecast mode (hourly or 7-day). Omitted when this is the last page.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when forecast data was last updated more than 24 hours ago, periods remain or the cursor points past the end, or requested amount data or layers are unavailable.',
      ),
  },

  enrichmentTrailer: {
    totalCount: { label: 'Total Periods' },
    shown: { label: 'Periods' },
    mode: { label: 'Mode' },
    nextCursor: { label: 'Next Cursor' },
  },

  async handler(input, ctx) {
    // A blank cursor (form clients) is the first page. A token minted in one mode
    // continues in it whatever `hourly` says; a 0.11.0 token has no mode and reads
    // `hourly`.
    const token = unsetIfBlank(input.cursor);
    const cursor = token === undefined ? undefined : readCursor(token, ctx);
    const hourly = cursor?.hourly ?? input.hourly;
    const mode = hourly ? 'hourly' : '7-day';

    const service = getNwsService();
    const result = input.include_amounts
      ? await service.getForecast(input.latitude, input.longitude, hourly, ctx, true)
      : await service.getForecast(input.latitude, input.longitude, hourly, ctx);

    const allPeriods = result.forecast.periods;
    const totalCount = allPeriods.length;

    // One window over the fetched array feeds both the returned `periods`
    // (structuredContent) and format() — a single slice through the single
    // MAX_PERIODS constant, per issue #23. The cursor reaches the periods past
    // it (issue #27) and carries its own page size, held to MAX_PERIODS.
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? MAX_PERIODS;
    const items = allPeriods.slice(offset, offset + limit);
    const nextCursor =
      offset + limit < totalCount
        ? encodeCursor({ offset: offset + limit, limit, hourly })
        : undefined;

    ctx.enrich({
      totalCount,
      shown: items.length,
      mode,
      ...(nextCursor ? { nextCursor } : {}),
    });

    // A grid whose office stops updating keeps its updateTime while generatedAt
    // keeps advancing, so only updateTime tells a stale forecast apart.
    const { updateTime } = result.forecast;
    const updateAgeMs = updateTime === null ? undefined : Date.now() - Date.parse(updateTime);
    const staleNotice =
      updateAgeMs !== undefined && updateAgeMs > STALE_UPDATE_MS
        ? `Forecast data was last updated ${Math.round(updateAgeMs / 360_000) / 10}h ago — NWS may have stopped updating this grid, so these periods may be out of date.`
        : undefined;

    let pagingNotice: string | undefined;
    if (nextCursor) {
      const lead = cursor
        ? `Returning ${items.length} more of ${totalCount} forecast periods.`
        : `Returning the first ${items.length} of ${totalCount} forecast periods to bound response size.`;
      pagingNotice = `${lead} Pass nextCursor back as cursor for the next window. Periods are contiguous within one response; NWS reissues forecasts through the day, so a later call can window a regenerated array.`;
    } else if (cursor && items.length === 0) {
      const restart = hourly
        ? 'Call again with hourly: true and no cursor to restart from the first hourly period.'
        : 'Call again with no cursor and hourly omitted or false to restart from the first 7-day period.';
      pagingNotice = `The cursor points past the end of this ${mode} forecast's ${totalCount} periods. ${restart}`;
    }

    const notice = composeNotice(staleNotice, pagingNotice, result.amountsNotice);
    if (notice) ctx.enrich.notice(notice);

    return {
      ...(result.precipitationAmounts !== undefined
        ? {
            precipitationAmounts: result.precipitationAmounts,
            amountsUpdateTime: result.amountsUpdateTime,
          }
        : {}),
      location: result.location,
      generatedAt: result.forecast.generatedAt,
      updateTime,
      periods: items.map((p) => ({
        name: periodLabel(p.name, p.startTime, result.location.timeZone),
        startTime: p.startTime,
        endTime: p.endTime,
        temperature: p.temperature,
        temperatureUnit: p.temperatureUnit,
        windSpeed: p.windSpeed,
        windDirection: p.windDirection,
        shortForecast: p.shortForecast,
        detailedForecast: p.detailedForecast,
        precipChancePct: p.probabilityOfPrecipitation.value,
        dewpointC: p.dewpoint.value != null ? Math.round(p.dewpoint.value * 10) / 10 : null,
        relativeHumidityPct:
          p.relativeHumidity.value != null ? Math.round(p.relativeHumidity.value * 10) / 10 : null,
      })),
    };
  },

  format: (result) => {
    const loc = result.location;
    const lines = [
      `## Forecast for ${escapeMarkdownInline(loc.city)}, ${escapeMarkdownInline(loc.state)}`,
      `**Office:** ${escapeMarkdownInline(loc.office)} | **Time Zone:** ${escapeMarkdownInline(loc.timeZone)} | **Forecast Zone:** ${escapeMarkdownInline(loc.forecastZone)} | **County Zone:** ${escapeMarkdownInline(loc.county)}`,
      `**Generated:** ${formatTimestamp(result.generatedAt, loc.timeZone)} | **Updated:** ${result.updateTime === null ? 'not reported' : formatTimestamp(result.updateTime, loc.timeZone)}`,
      '',
    ];

    if (result.periods.length === 0) {
      lines.push('No forecast periods available for this location.');
    }

    for (const p of result.periods) {
      const precip = p.precipChancePct != null ? ` | **Precip:** ${p.precipChancePct}%` : '';
      const humidity =
        p.relativeHumidityPct != null ? ` | **Humidity:** ${p.relativeHumidityPct}%` : '';
      const dew =
        p.dewpointC != null ? ` | **Dewpoint:** ${cToF(p.dewpointC)}°F (${p.dewpointC}°C)` : '';

      const timeRange = `${formatTimestamp(p.startTime, loc.timeZone)} → ${formatTimestamp(p.endTime, loc.timeZone)}`;
      lines.push(`### ${escapeMarkdownInline(p.name)} — ${escapeMarkdownInline(p.shortForecast)}`);
      lines.push(`_${timeRange}_`);
      const tempDual =
        p.temperatureUnit === 'F'
          ? `${p.temperature}°${escapeMarkdownInline(p.temperatureUnit)} (${fToC(p.temperature)}°C)`
          : `${cToF(p.temperature)}°F (${p.temperature}°${escapeMarkdownInline(p.temperatureUnit)})`;
      lines.push(
        `**${tempDual}** | **Wind:** ${escapeMarkdownInline(p.windSpeed)} ${escapeMarkdownInline(p.windDirection)}${precip}${humidity}${dew}`,
      );
      if (p.detailedForecast) {
        lines.push(escapeMarkdownInline(p.detailedForecast));
      }
      lines.push('');
    }

    if (result.precipitationAmounts !== undefined) {
      if (result.amountsUpdateTime === undefined)
        throw new Error('Precipitation amounts require amountsUpdateTime (a timestamp or null).');
      lines.push(
        `## Precipitation Amounts`,
        `**Amounts Updated:** ${result.amountsUpdateTime === null ? 'null' : escapeMarkdownInline(result.amountsUpdateTime)}`,
      );
      for (const layer of result.precipitationAmounts) {
        lines.push(
          `### ${layer.layer}`,
          `**Unit:** ${layer.uom === null ? 'null' : escapeMarkdownInline(layer.uom)}`,
        );
        if (layer.values.length === 0) lines.push('Intervals: []');
        for (const interval of layer.values)
          lines.push(
            `${escapeMarkdownInline(interval.validTime)}: ${interval.value === null ? 'null' : interval.value}`,
          );
      }
      if (result.precipitationAmounts.length === 0) lines.push('Layers: []');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
