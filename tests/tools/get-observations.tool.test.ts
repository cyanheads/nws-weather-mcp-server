/**
 * @fileoverview Tests for nws_get_observations tool.
 * @module tests/tools/get-observations
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservationResult } from '@/services/nws/nws-service.js';

const mockGetObservation = vi.fn<() => Promise<ObservationResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ getObservation: mockGetObservation }),
}));

const { getObservationsTool } = await import(
  '@/mcp-server/tools/definitions/get-observations.tool.js'
);

// Fixture carries the raw long-float shape NWS actually returns (e.g.
// relativeHumidity 66.720955975373, barometricPressure 101693.25) so handler
// tests can assert the rounding that keeps structuredContent in parity with format().
const observationResult: ObservationResult = {
  observation: {
    stationId: 'KSEA',
    stationName: 'Seattle-Tacoma International Airport',
    timestamp: '2026-04-03T11:53:00+00:00',
    timeZone: 'America/Los_Angeles',
    textDescription: 'Mostly Cloudy',
    temperature: { value: 12.4, unitCode: 'wmoUnit:degC' },
    dewpoint: { value: 8.347, unitCode: 'wmoUnit:degC' },
    windSpeed: { value: 14.832, unitCode: 'wmoUnit:km_h-1' },
    windDirection: { value: 199.6, unitCode: 'wmoUnit:degree_(angle)' },
    windGust: { value: null, unitCode: 'wmoUnit:km_h-1' },
    barometricPressure: { value: 101693.25, unitCode: 'wmoUnit:Pa' },
    visibility: { value: 16093.44, unitCode: 'wmoUnit:m' },
    relativeHumidity: { value: 66.720955975373, unitCode: 'wmoUnit:percent' },
    heatIndex: { value: null, unitCode: 'wmoUnit:degC' },
    windChill: { value: null, unitCode: 'wmoUnit:degC' },
    cloudLayers: [{ base: { value: 1524.123, unitCode: 'wmoUnit:m' }, amount: 'BKN' }],
  },
};

describe('nws_get_observations', () => {
  beforeEach(() => {
    mockGetObservation.mockReset();
  });

  it('accepts station_id input', () => {
    const input = getObservationsTool.input.parse({ station_id: 'KSEA' });
    expect(input.station_id).toBe('KSEA');
  });

  it('accepts coordinate input', () => {
    const input = getObservationsTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    expect(input.latitude).toBe(47.6);
    expect(input.longitude).toBe(-122.3);
  });

  it('returns observation data by station ID', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getObservationsTool.input.parse({ station_id: 'KSEA' });
    const result = await getObservationsTool.handler(input, ctx);

    expect(result.stationId).toBe('KSEA');
    expect(result.timeZone).toBe('America/Los_Angeles');
    expect(result.textDescription).toBe('Mostly Cloudy');
    expect(result.windGustKmh).toBeNull();
    expect(result.cloudLayers).toHaveLength(1);
    expect(result.cloudLayers[0].amount).toBe('BKN');
  });

  it('rounds raw upstream float fields in structuredContent to match format()', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getObservationsTool.input.parse({ station_id: 'KSEA' });
    const result = await getObservationsTool.handler(input, ctx);

    // Raw upstream floats round to the integer precision format() renders, so the
    // structured channel and the markdown channel never disagree.
    expect(result.temperatureC).toBe(12); // 12.4
    expect(result.dewpointC).toBe(8); // 8.347
    expect(result.windSpeedKmh).toBe(15); // 14.832
    expect(result.windDirectionDeg).toBe(200); // 199.6
    expect(result.barometricPressurePa).toBe(101693); // 101693.25
    expect(result.visibilityM).toBe(16093); // 16093.44
    expect(result.relativeHumidityPct).toBe(67); // 66.720955975373
    expect(result.cloudLayers[0].baseM).toBe(1524); // 1524.123
  });

  it('preserves null measurements through rounding (does not coerce to 0)', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getObservationsTool.input.parse({ station_id: 'KSEA' });
    const result = await getObservationsTool.handler(input, ctx);

    expect(result.windGustKmh).toBeNull();
    expect(result.heatIndexC).toBeNull();
    expect(result.windChillC).toBeNull();
  });

  it('trims station_id before calling the service', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getObservationsTool.input.parse({ station_id: ' KSEA ' });
    await getObservationsTool.handler(input, ctx);

    expect(mockGetObservation).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'KSEA' }),
      ctx,
    );
  });

  it('returns observation data by coordinates', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getObservationsTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    const result = await getObservationsTool.handler(input, ctx);

    expect(result.stationId).toBe('KSEA');
    expect(mockGetObservation).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 47.6, longitude: -122.3 }),
      ctx,
    );
  });

  it('ignores blank station_id when coordinates are provided', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getObservationsTool.input.parse({
      station_id: '   ',
      latitude: 47.6,
      longitude: -122.3,
    });
    await getObservationsTool.handler(input, ctx);

    expect(mockGetObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        stationId: undefined,
        latitude: 47.6,
        longitude: -122.3,
      }),
      ctx,
    );
  });

  it('throws when neither station_id nor coordinates provided', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
    const input = getObservationsTool.input.parse({});
    const result = getObservationsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'missing_input',
        recovery: { hint: expect.stringContaining('station_id or both latitude and longitude') },
      },
    });
  });

  it('treats whitespace-only station_id as omitted when coordinates are missing', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
    const input = getObservationsTool.input.parse({ station_id: '   ' });
    const result = getObservationsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'missing_input',
        recovery: { hint: expect.stringContaining('station_id or both latitude and longitude') },
      },
    });
  });

  it('throws when only latitude provided', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
    const input = getObservationsTool.input.parse({ latitude: 47.6 });
    const result = getObservationsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'missing_input',
        recovery: { hint: expect.stringContaining('station_id or both latitude and longitude') },
      },
    });
  });

  describe('enrichment', () => {
    it('populates station and observedAt on success', async () => {
      mockGetObservation.mockResolvedValueOnce(observationResult);

      const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
      const input = getObservationsTool.input.parse({ station_id: 'KSEA' });
      await getObservationsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment).toMatchObject({
        station: 'KSEA',
        observedAt: '2026-04-03T11:53:00+00:00',
      });
      // No staleness notice — fixture timestamp is recent relative to no real clock
      // (the test doesn't control wall-clock, so we only assert notice is absent
      // when the timestamp is exactly as returned by the mock)
    });

    it('adds a staleness notice when observation is more than 2 hours old', async () => {
      // Set the timestamp to 3 hours ago
      const staleTimestamp = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const staleResult: ObservationResult = {
        observation: {
          ...observationResult.observation,
          timestamp: staleTimestamp,
        },
      };
      mockGetObservation.mockResolvedValueOnce(staleResult);

      const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
      const input = getObservationsTool.input.parse({ station_id: 'KSEA' });
      await getObservationsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment).toHaveProperty('notice');
      expect(typeof enrichment.notice).toBe('string');
      expect(enrichment.notice as string).toContain('old');
    });

    it('does not add a staleness notice for fresh observations', async () => {
      // Set the timestamp to 30 minutes ago
      const freshTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const freshResult: ObservationResult = {
        observation: {
          ...observationResult.observation,
          timestamp: freshTimestamp,
        },
      };
      mockGetObservation.mockResolvedValueOnce(freshResult);

      const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
      const input = getObservationsTool.input.parse({ station_id: 'KSEA' });
      await getObservationsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment).not.toHaveProperty('notice');
    });
  });

  describe('format', () => {
    it('renders observation with unit conversions', () => {
      const output = {
        stationId: 'KSEA',
        stationName: 'Seattle-Tacoma International Airport',
        timestamp: '2026-04-03T11:53:00+00:00',
        timeZone: 'America/Los_Angeles',
        textDescription: 'Mostly Cloudy',
        temperatureC: 14.4,
        dewpointC: 8.3,
        windSpeedKmh: 18.5,
        windDirectionDeg: 200,
        windGustKmh: null,
        barometricPressurePa: 101325,
        visibilityM: 16093,
        relativeHumidityPct: 65.2,
        heatIndexC: null,
        windChillC: null,
        cloudLayers: [{ amount: 'BKN', baseM: 1524 }],
      };

      const blocks = getObservationsTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('KSEA');
      expect(text).toContain('Mostly Cloudy');
      // Should show both F and C
      expect(text).toMatch(/\d+°F \(\d+°C\)/);
      // Should show wind
      expect(text).toContain('mph');
      // Should show pressure in both units
      expect(text).toContain('inHg');
      expect(text).toContain('hPa');
      // Should show clouds
      expect(text).toContain('BKN');
    });

    it('omits the bold conditions segment (no ****) when textDescription is empty', () => {
      const output = {
        stationId: 'KSEA',
        stationName: 'Seattle-Tacoma International Airport',
        timestamp: '2026-04-03T11:53:00+00:00',
        timeZone: 'America/Los_Angeles',
        textDescription: '',
        temperatureC: 12,
        dewpointC: 8,
        windSpeedKmh: 15,
        windDirectionDeg: 200,
        windGustKmh: null,
        barometricPressurePa: 101693,
        visibilityM: 16093,
        relativeHumidityPct: 67,
        heatIndexC: null,
        windChillC: null,
        cloudLayers: [],
      };

      const blocks = getObservationsTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).not.toContain('****');
      // The observed-time line still renders, just without a leading bold blank.
      expect(text).toContain('Observed:');
      expect(text).not.toMatch(/\*\*\s*\*\*/);
    });

    it('handles null values gracefully', () => {
      const output = {
        stationId: 'KSEA',
        stationName: 'KSEA',
        timestamp: '2026-04-03T06:00:00-10:00',
        timeZone: 'Pacific/Honolulu',
        textDescription: 'Clear',
        temperatureC: null,
        dewpointC: null,
        windSpeedKmh: null,
        windDirectionDeg: null,
        windGustKmh: null,
        barometricPressurePa: null,
        visibilityM: null,
        relativeHumidityPct: null,
        heatIndexC: null,
        windChillC: null,
        cloudLayers: [],
      };

      const blocks = getObservationsTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('KSEA');
      expect(text).toContain('Clear');
      expect(text).toContain('6:00 AM HST');
      expect(text).toContain('Not available');
    });
  });
});
