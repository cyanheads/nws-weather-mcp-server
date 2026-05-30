/**
 * @fileoverview Tool: nws_get_observations — retrieves current weather observations.
 * @module mcp-server/tools/definitions/get-observations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNwsService } from '@/services/nws/nws-service.js';
import { cToF, formatTimestamp } from '../format-utils.js';

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

/** Format temperature with both F and C. */
function formatTemp(value: number | null): string | null {
  if (value == null) return null;
  const c = Math.round(value);
  return `${cToF(value)}°F (${c}°C)`;
}

/** Format wind speed with both mph and km/h. */
function formatWind(speed: number | null, direction: number | null, gust: number | null): string {
  if (speed == null) return 'Not available';
  if (Math.round(speed) === 0 && gust == null) return 'Calm';
  const mph = kmhToMph(speed);
  const kmh = Math.round(speed);
  const dir = direction != null ? `${Math.round(direction)}°` : '';
  let result = `${dir} ${mph} mph (${kmh} km/h)`.trim();
  if (gust != null) {
    result += `, gusts ${kmhToMph(gust)} mph (${Math.round(gust)} km/h)`;
  }
  return result;
}

/** Trim optional station IDs and treat blank values as omitted. */
function normalizeStationId(stationId: string | undefined): string | undefined {
  if (stationId == null) return;
  const normalized = stationId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export const getObservationsTool = tool('nws_get_observations', {
  description:
    'Get current weather observations (actual measured conditions). Accepts coordinates (resolves nearest station automatically) or a station ID directly (e.g., "KSEA").',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'missing_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither station_id nor a (latitude, longitude) pair was provided',
      recovery: 'Provide either station_id or both latitude and longitude.',
    },
    {
      reason: 'station_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Station ID does not exist in the NWS network',
      recovery: 'Use nws_find_stations to discover valid station IDs near a coordinate.',
    },
    {
      reason: 'no_observations',
      code: JsonRpcErrorCode.NotFound,
      when: 'Station has no recent observations available',
      recovery: 'Try a different station — use nws_find_stations to find alternatives nearby.',
    },
    {
      reason: 'no_stations_nearby',
      code: JsonRpcErrorCode.NotFound,
      when: 'No observation stations exist near the requested coordinates',
      recovery: 'Try a different location or broaden the search by moving inland.',
    },
    {
      reason: 'out_of_scope',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Coordinates fall outside US National Weather Service coverage',
      recovery: 'Provide coordinates within US states, territories, or adjacent marine areas.',
    },
  ],

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
    timeZone: z.string().nullable().describe('Station time zone when known'),
    textDescription: z.string().describe('Conditions summary (e.g., "Mostly Cloudy")'),
    temperatureC: z.number().nullable().describe('Temperature in Celsius'),
    dewpointC: z.number().nullable().describe('Dewpoint in Celsius'),
    windSpeedKmh: z.number().nullable().describe('Wind speed in km/h'),
    windDirectionDeg: z.number().nullable().describe('Wind direction in degrees (0-360)'),
    windGustKmh: z.number().nullable().describe('Wind gust in km/h'),
    barometricPressurePa: z.number().nullable().describe('Barometric pressure in Pascals'),
    visibilityM: z.number().nullable().describe('Visibility in meters'),
    relativeHumidityPct: z.number().nullable().describe('Relative humidity in percent (0-100)'),
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
  }),

  // Result-set context for the agent — station echo (disjoint from output fields)
  // and a staleness notice when the latest observation is more than 2 hours old.
  enrichment: {
    station: z.string().describe('Station ID that served the observation (e.g., "KSEA")'),
    observedAt: z.string().describe('Observation timestamp (ISO 8601)'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the latest observation is more than 2 hours old — data may not reflect current conditions.',
      ),
  },

  enrichmentTrailer: {
    station: { label: 'Station' },
    observedAt: { label: 'Observed' },
  },

  async handler(input, ctx) {
    const normalizedStationId = normalizeStationId(input.station_id);

    if (!normalizedStationId && (input.latitude == null || input.longitude == null)) {
      throw ctx.fail('missing_input', undefined, {
        ...ctx.recoveryFor('missing_input'),
      });
    }

    const result = await getNwsService().getObservation(
      {
        latitude: input.latitude,
        longitude: input.longitude,
        stationId: normalizedStationId,
      },
      ctx,
    );

    const obs = result.observation;

    ctx.enrich({
      station: obs.stationId,
      observedAt: obs.timestamp,
    });

    // Flag stale observations — NWS stations report roughly every hour.
    // Anything older than 2 hours warrants a notice.
    const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
    const observedMs = new Date(obs.timestamp).getTime();
    if (!Number.isNaN(observedMs) && Date.now() - observedMs > STALE_THRESHOLD_MS) {
      const ageHours = Math.round(((Date.now() - observedMs) / 3_600_000) * 10) / 10;
      ctx.enrich.notice(
        `Observation is ${ageHours}h old — data may not reflect current conditions. Try a different station using nws_find_stations.`,
      );
    }

    return {
      stationId: obs.stationId,
      stationName: obs.stationName,
      timestamp: obs.timestamp,
      timeZone: obs.timeZone,
      textDescription: obs.textDescription,
      temperatureC: obs.temperature.value,
      dewpointC: obs.dewpoint.value,
      windSpeedKmh: obs.windSpeed.value,
      windDirectionDeg: obs.windDirection.value,
      windGustKmh: obs.windGust.value,
      barometricPressurePa: obs.barometricPressure.value,
      visibilityM: obs.visibility.value,
      relativeHumidityPct: obs.relativeHumidity.value,
      heatIndexC: obs.heatIndex.value,
      windChillC: obs.windChill.value,
      cloudLayers: obs.cloudLayers.map((l) => ({
        amount: l.amount,
        baseM: l.base.value,
      })),
    };
  },

  format: (result) => {
    const zoneSuffix = result.timeZone ? ` (${result.timeZone})` : '';
    const lines = [
      `## Current Conditions — ${result.stationName} (${result.stationId})`,
      `**${result.textDescription}** | Observed: ${formatTimestamp(result.timestamp, result.timeZone)}${zoneSuffix}`,
      '',
    ];

    const temp = formatTemp(result.temperatureC);
    if (temp) lines.push(`**Temperature:** ${temp}`);

    const dew = formatTemp(result.dewpointC);
    if (dew) lines.push(`**Dewpoint:** ${dew}`);

    if (result.relativeHumidityPct != null) {
      lines.push(`**Humidity:** ${Math.round(result.relativeHumidityPct)}%`);
    }

    lines.push(
      `**Wind:** ${formatWind(result.windSpeedKmh, result.windDirectionDeg, result.windGustKmh)}`,
    );

    if (result.barometricPressurePa != null) {
      const pa = Math.round(result.barometricPressurePa);
      const pressure = `${paToInHg(result.barometricPressurePa)} inHg (${Math.round(result.barometricPressurePa / 100)} hPa, ${pa} Pa)`;
      lines.push(`**Pressure:** ${pressure}`);
    }

    if (result.visibilityM != null) {
      const m = Math.round(result.visibilityM);
      lines.push(
        `**Visibility:** ${mToMi(result.visibilityM)} mi (${mToKm(result.visibilityM)} km, ${m} m)`,
      );
    }

    const heat = formatTemp(result.heatIndexC);
    if (heat) lines.push(`**Heat Index:** ${heat}`);

    const chill = formatTemp(result.windChillC);
    if (chill) lines.push(`**Wind Chill:** ${chill}`);

    if (result.cloudLayers.length > 0) {
      const clouds = result.cloudLayers
        .map((l) => {
          const base = l.baseM != null ? ` at ${Math.round(l.baseM)}m (${mToFt(l.baseM)} ft)` : '';
          return `${l.amount}${base}`;
        })
        .join(', ');
      lines.push(`**Clouds:** ${clouds}`);
    }

    // Flag when most measurements are missing
    const measurable = [
      result.temperatureC,
      result.dewpointC,
      result.windSpeedKmh,
      result.barometricPressurePa,
      result.visibilityM,
      result.relativeHumidityPct,
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
