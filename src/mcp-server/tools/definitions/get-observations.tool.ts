/**
 * @fileoverview Tool: nws_get_observations — retrieves current weather observations.
 * @module mcp-server/tools/definitions/get-observations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNwsService } from '@/services/nws/nws-service.js';

/** Convert Celsius to Fahrenheit. */
function cToF(c: number): number {
  return Math.round(c * 1.8 + 32);
}

/** Convert km/h to mph. */
function kmhToMph(kmh: number): number {
  return Math.round(kmh * 0.621371);
}

/** Convert Pascals to inHg. */
function paToInHg(pa: number): number {
  return Math.round(pa * 0.0002953 * 100) / 100;
}

/** Convert meters to miles. */
function mToMi(m: number): number {
  return Math.round(m * 0.000621371 * 10) / 10;
}

/** Convert meters to km. */
function mToKm(m: number): number {
  return Math.round(m / 100) / 10;
}

/** Convert meters to feet. */
function mToFt(m: number): number {
  return Math.round(m * 3.28084);
}

/** Format an ISO 8601 timestamp as a short human-readable string. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** Format temperature with both F and C. */
function formatTemp(value: number | null): string | null {
  if (value == null) return null;
  const c = Math.round(value);
  return `${cToF(value)}°F (${c}°C)`;
}

/** Format wind speed with both mph and km/h. */
function formatWind(speed: number | null, direction: number | null, gust: number | null): string {
  if (speed == null) return 'Calm';
  const mph = kmhToMph(speed);
  const kmh = Math.round(speed);
  const dir = direction != null ? `${Math.round(direction)}°` : '';
  let result = `${dir} ${mph} mph (${kmh} km/h)`.trim();
  if (gust != null) {
    result += `, gusts ${kmhToMph(gust)} mph`;
  }
  return result;
}

export const getObservationsTool = tool('nws_get_observations', {
  description:
    'Get current weather observations (actual measured conditions). Accepts coordinates (resolves nearest station automatically) or a station ID directly (e.g., "KSEA").',
  annotations: { readOnlyHint: true },

  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Latitude for automatic station resolution. Use with longitude. Ignored if station_id is provided.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(
        'Longitude for automatic station resolution. Use with latitude. Ignored if station_id is provided.',
      ),
    station_id: z
      .string()
      .optional()
      .describe(
        'Station identifier directly (e.g., "KSEA", "KORD"). Use nws_find_stations to discover station IDs.',
      ),
  }),

  output: z.object({
    stationId: z.string().describe('Observation station ID'),
    stationName: z.string().describe('Station name'),
    timestamp: z.string().describe('Observation time (ISO 8601)'),
    textDescription: z.string().describe('Conditions summary (e.g., "Mostly Cloudy")'),
    temperature: z.number().nullable().describe('Temperature in Celsius'),
    dewpoint: z.number().nullable().describe('Dewpoint in Celsius'),
    windSpeed: z.number().nullable().describe('Wind speed in km/h'),
    windDirection: z.number().nullable().describe('Wind direction in degrees'),
    windGust: z.number().nullable().describe('Wind gust in km/h'),
    barometricPressure: z.number().nullable().describe('Barometric pressure in Pascals'),
    visibility: z.number().nullable().describe('Visibility in meters'),
    relativeHumidity: z.number().nullable().describe('Relative humidity (%)'),
    heatIndex: z.number().nullable().describe('Heat index in Celsius'),
    windChill: z.number().nullable().describe('Wind chill in Celsius'),
    cloudLayers: z
      .array(
        z.object({
          amount: z.string().describe('Cloud cover (e.g., "FEW", "SCT", "BKN", "OVC")'),
          base: z.number().nullable().describe('Cloud base height in meters'),
        }),
      )
      .describe('Cloud layer information'),
  }),

  async handler(input, ctx) {
    if (!input.station_id && (input.latitude == null || input.longitude == null)) {
      throw new Error('Provide either station_id or both latitude and longitude.');
    }

    const result = await getNwsService().getObservation(
      {
        latitude: input.latitude,
        longitude: input.longitude,
        stationId: input.station_id,
      },
      ctx,
    );

    const obs = result.observation;
    return {
      stationId: obs.stationId,
      stationName: obs.stationName,
      timestamp: obs.timestamp,
      textDescription: obs.textDescription,
      temperature: obs.temperature.value,
      dewpoint: obs.dewpoint.value,
      windSpeed: obs.windSpeed.value,
      windDirection: obs.windDirection.value,
      windGust: obs.windGust.value,
      barometricPressure: obs.barometricPressure.value,
      visibility: obs.visibility.value,
      relativeHumidity: obs.relativeHumidity.value,
      heatIndex: obs.heatIndex.value,
      windChill: obs.windChill.value,
      cloudLayers: obs.cloudLayers.map((l) => ({
        amount: l.amount,
        base: l.base.value,
      })),
    };
  },

  format: (result) => {
    const lines = [
      `## Current Conditions — ${result.stationName} (${result.stationId})`,
      `**${result.textDescription}** | Observed: ${formatTimestamp(result.timestamp)}`,
      '',
    ];

    const temp = formatTemp(result.temperature);
    if (temp) lines.push(`**Temperature:** ${temp}`);

    const dew = formatTemp(result.dewpoint);
    if (dew) lines.push(`**Dewpoint:** ${dew}`);

    if (result.relativeHumidity != null) {
      lines.push(`**Humidity:** ${Math.round(result.relativeHumidity)}%`);
    }

    lines.push(`**Wind:** ${formatWind(result.windSpeed, result.windDirection, result.windGust)}`);

    if (result.barometricPressure != null) {
      const pressure = `${paToInHg(result.barometricPressure)} inHg (${Math.round(result.barometricPressure / 100)} hPa)`;
      lines.push(`**Pressure:** ${pressure}`);
    }

    if (result.visibility != null) {
      lines.push(`**Visibility:** ${mToMi(result.visibility)} mi (${mToKm(result.visibility)} km)`);
    }

    const heat = formatTemp(result.heatIndex);
    if (heat) lines.push(`**Heat Index:** ${heat}`);

    const chill = formatTemp(result.windChill);
    if (chill) lines.push(`**Wind Chill:** ${chill}`);

    if (result.cloudLayers.length > 0) {
      const clouds = result.cloudLayers
        .map((l) => {
          const base = l.base != null ? ` at ${Math.round(l.base)}m (${mToFt(l.base)} ft)` : '';
          return `${l.amount}${base}`;
        })
        .join(', ');
      lines.push(`**Clouds:** ${clouds}`);
    }

    // Flag when most measurements are missing
    const measurable = [
      result.temperature,
      result.dewpoint,
      result.windSpeed,
      result.barometricPressure,
      result.visibility,
      result.relativeHumidity,
    ];
    const nullCount = measurable.filter((v) => v == null).length;
    if (nullCount >= 4) {
      lines.push('');
      lines.push(
        '_Limited data — most measurements unavailable from this station. Try a different station using nws_find_stations._',
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
