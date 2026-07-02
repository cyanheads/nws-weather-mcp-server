/**
 * @fileoverview Tool: nws_get_forecast — retrieves weather forecast for US coordinates.
 * @module mcp-server/tools/definitions/get-forecast
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNwsService } from '@/services/nws/nws-service.js';
import { cToF, formatTimestamp, fToC } from '../format-utils.js';

/**
 * Maximum forecast periods returned per call. Applied in the handler so
 * `structuredContent` and `content[]` share the same bounded projection —
 * the upstream hourly feed carries ~156 periods (7 days), which floods
 * context unbounded. The pre-cap total is surfaced via the
 * `totalPeriodCount` enrichment field, with a notice when truncation occurs.
 */
const MAX_PERIODS = 48;

/**
 * Derive a period label from startTime when name is empty (hourly periods).
 * Renders in the forecast location's IANA zone so headers agree with the time
 * range rendered immediately below them.
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
      recovery: 'Provide coordinates within US states, territories, or adjacent marine areas.',
    },
  ],

  input: z.object({
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
        'If true, returns hourly forecast (next 48 one-hour periods) instead of 12-hour named periods (14 periods). Hourly includes dewpoint and relative humidity.',
      ),
  }),

  output: z.object({
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
    generatedAt: z.string().describe('When the forecast was generated (ISO 8601)'),
    periods: z
      .array(
        z
          .object({
            name: z.string().describe('Period name (e.g., "Today", "Tonight") or hour label'),
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
  // without re-deriving from the array. generatedAt already lives in output;
  // not duplicated here.
  enrichment: {
    periodCount: z
      .number()
      .describe(`Number of forecast periods returned (capped at ${MAX_PERIODS}).`),
    totalPeriodCount: z
      .number()
      .describe('Total forecast periods available upstream before the cap was applied.'),
    mode: z.string().describe('Forecast mode: "hourly" or "7-day"'),
    notice: z
      .string()
      .optional()
      .describe(
        'Set when upstream returned more periods than the cap — states how many periods were omitted.',
      ),
  },

  enrichmentTrailer: {
    periodCount: { label: 'Periods' },
    totalPeriodCount: { label: 'Total Periods' },
    mode: { label: 'Mode' },
  },

  async handler(input, ctx) {
    const result = await getNwsService().getForecast(
      input.latitude,
      input.longitude,
      input.hourly,
      ctx,
    );

    const totalPeriodCount = result.forecast.periods.length;
    const periods = result.forecast.periods.slice(0, MAX_PERIODS);

    ctx.enrich({
      periodCount: periods.length,
      totalPeriodCount,
      mode: input.hourly ? 'hourly' : '7-day',
    });
    if (totalPeriodCount > MAX_PERIODS) {
      ctx.enrich.notice(
        `Returning the first ${MAX_PERIODS} of ${totalPeriodCount} forecast periods; the remaining ${totalPeriodCount - MAX_PERIODS} were omitted to bound response size.`,
      );
    }

    return {
      location: result.location,
      generatedAt: result.forecast.generatedAt,
      periods: periods.map((p) => ({
        name: p.name,
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
      `## Forecast for ${loc.city}, ${loc.state}`,
      `**Office:** ${loc.office} | **Time Zone:** ${loc.timeZone} | **Forecast Zone:** ${loc.forecastZone} | **County Zone:** ${loc.county}`,
      `**Generated:** ${formatTimestamp(result.generatedAt, loc.timeZone)}`,
      '',
    ];

    if (result.periods.length === 0) {
      lines.push('No forecast periods available for this location.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const p of result.periods) {
      const precip = p.precipChancePct != null ? ` | **Precip:** ${p.precipChancePct}%` : '';
      const humidity =
        p.relativeHumidityPct != null ? ` | **Humidity:** ${p.relativeHumidityPct}%` : '';
      const dew =
        p.dewpointC != null
          ? ` | **Dewpoint:** ${cToF(p.dewpointC)}°F (${Math.round(p.dewpointC)}°C)`
          : '';

      const timeRange = `${formatTimestamp(p.startTime, loc.timeZone)} → ${formatTimestamp(p.endTime, loc.timeZone)}`;
      lines.push(`### ${periodLabel(p.name, p.startTime, loc.timeZone)} — ${p.shortForecast}`);
      lines.push(`_${timeRange}_`);
      const tempDual =
        p.temperatureUnit === 'F'
          ? `${p.temperature}°${p.temperatureUnit} (${fToC(p.temperature)}°C)`
          : `${cToF(p.temperature)}°F (${p.temperature}°${p.temperatureUnit})`;
      lines.push(
        `**${tempDual}** | **Wind:** ${p.windSpeed} ${p.windDirection}${precip}${humidity}${dew}`,
      );
      if (p.detailedForecast) {
        lines.push(p.detailedForecast);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
