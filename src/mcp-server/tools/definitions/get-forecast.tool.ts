/**
 * @fileoverview Tool: nws_get_forecast — retrieves weather forecast for US coordinates.
 * @module mcp-server/tools/definitions/get-forecast
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNwsService } from '@/services/nws/nws-service.js';
import { cToF, formatTimestamp, fToC } from '../format-utils.js';

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
    'Get the weather forecast for a US location. Returns either named 12-hour periods (default) or hourly breakdowns. Internally resolves coordinates to the NWS grid.',
  annotations: { readOnlyHint: true },

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe('Latitude in decimal degrees (e.g., 47.6062). Truncated to 4 decimal places.'),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe('Longitude in decimal degrees (e.g., -122.3321). Truncated to 4 decimal places.'),
    hourly: z
      .boolean()
      .default(false)
      .describe(
        'If true, returns hourly forecast (~156 periods) instead of 12-hour named periods (14 periods). Hourly includes dewpoint and relative humidity.',
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
            precipChance: z.number().nullable().describe('Probability of precipitation (%)'),
            dewpoint: z.number().nullable().describe('Dewpoint in Celsius (hourly only)'),
            relativeHumidity: z.number().nullable().describe('Relative humidity % (hourly only)'),
          })
          .describe('Single forecast period with time range, conditions, and narrative'),
      )
      .describe('Forecast periods'),
  }),

  async handler(input, ctx) {
    const result = await getNwsService().getForecast(
      input.latitude,
      input.longitude,
      input.hourly,
      ctx,
    );

    return {
      location: result.location,
      generatedAt: result.forecast.generatedAt,
      periods: result.forecast.periods.map((p) => ({
        name: p.name,
        startTime: p.startTime,
        endTime: p.endTime,
        temperature: p.temperature,
        temperatureUnit: p.temperatureUnit,
        windSpeed: p.windSpeed,
        windDirection: p.windDirection,
        shortForecast: p.shortForecast,
        detailedForecast: p.detailedForecast,
        precipChance: p.probabilityOfPrecipitation.value,
        dewpoint: p.dewpoint.value != null ? Math.round(p.dewpoint.value * 10) / 10 : null,
        relativeHumidity:
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

    const periods = result.periods.slice(0, 48);

    for (const p of periods) {
      const precip = p.precipChance != null ? ` | **Precip:** ${p.precipChance}%` : '';
      const humidity = p.relativeHumidity != null ? ` | **Humidity:** ${p.relativeHumidity}%` : '';
      const dew =
        p.dewpoint != null
          ? ` | **Dewpoint:** ${cToF(p.dewpoint)}°F (${Math.round(p.dewpoint)}°C)`
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

    if (result.periods.length > 48) {
      lines.push(
        `_...and ${result.periods.length - 48} more periods (${result.periods.length} total)._`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
