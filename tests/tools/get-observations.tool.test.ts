/**
 * @fileoverview Tests for nws_get_observations tool.
 * @module tests/tools/get-observations
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
    precipitationLastHour: { value: null, unitCode: 'wmoUnit:mm' },
    precipitationLast3Hours: { value: null, unitCode: 'wmoUnit:mm' },
    precipitationLast6Hours: { value: null, unitCode: 'wmoUnit:mm' },
    cloudLayers: [{ base: { value: 1524.123, unitCode: 'wmoUnit:m' }, amount: 'BKN' }],
  },
};

describe('nws_get_observations', () => {
  it.each([3, 4, 6])(
    'preserves zero measurements and the %i-missing completeness boundary',
    async (missing) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-03T12:00:00Z'));
      try {
        const observation = { ...observationResult.observation };
        const keys = [
          'temperature',
          'dewpoint',
          'windSpeed',
          'barometricPressure',
          'visibility',
          'relativeHumidity',
        ] as const;
        keys.forEach((key, index) => {
          observation[key] = { ...observation[key], value: index < missing ? null : 0 };
        });
        mockGetObservation.mockResolvedValueOnce({ observation });
        const result = await runToolContract(getObservationsTool, { station_id: 'KSEA' });
        const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
        expect(result.structuredContent).toMatchObject({
          temperatureC: null,
          relativeHumidityPct: missing === 6 ? null : 0,
        });
        expect(text.includes('Limited data')).toBe(missing >= 4);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    'enriches sparse observations once on both surfaces (stale: %s)',
    async (stale) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-03T12:00:00Z'));
      try {
        const observation = {
          ...observationResult.observation,
          timestamp: stale ? '2026-04-03T09:00:00Z' : '2026-04-03T11:30:00Z',
        };
        for (const key of ['dewpoint', 'windSpeed', 'barometricPressure', 'visibility'] as const)
          observation[key] = { ...observation[key], value: null };
        mockGetObservation.mockResolvedValueOnce({ observation });
        const result = await runToolContract(getObservationsTool, { station_id: 'KSEA' });
        expect(result.structuredContent).toMatchObject({
          notice: expect.stringContaining('Limited data'),
        });
        const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
        expect(text.match(/Limited data/g)).toHaveLength(1);
        expect(text.includes('3h old')).toBe(stale);
      } finally {
        vi.useRealTimers();
      }
    },
  );
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

    const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
    const input = getObservationsTool.input.parse({ station_id: 'KSEA' });
    const result = await getObservationsTool.handler(input, ctx);

    expect(result.stationId).toBe('KSEA');
    expect(result.timeZone).toBe('America/Los_Angeles');
    expect(result.textDescription).toBe('Mostly Cloudy');
    expect(result.windGustKmh).toBeNull();
    expect(result.cloudLayers).toHaveLength(1);
    expect(result.cloudLayers[0]!.amount).toBe('BKN');
  });

  it('rounds raw upstream float fields in structuredContent to match format()', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
    const input = getObservationsTool.input.parse({ station_id: 'KSEA' });
    const result = await getObservationsTool.handler(input, ctx);

    // Raw upstream floats round to the precision format() renders — temperatures to
    // one decimal, everything else to an integer — so the structured channel and the
    // markdown channel never disagree.
    expect(result.temperatureC).toBe(12.4); // 12.4
    expect(result.dewpointC).toBe(8.3); // 8.347
    expect(result.windSpeedKmh).toBe(15); // 14.832
    expect(result.windDirectionDeg).toBe(200); // 199.6
    expect(result.barometricPressurePa).toBe(101693); // 101693.25
    expect(result.visibilityM).toBe(16093); // 16093.44
    expect(result.relativeHumidityPct).toBe(67); // 66.720955975373
    expect(result.cloudLayers[0]!.baseM).toBe(1524); // 1524.123
  });

  it('keeps METAR tenths on both surfaces and derives °F from the one-decimal value (issue #64)', async () => {
    // KPDX 2026-10-23T06:53Z: raw `08/03 … T00830033`, NWS-computed wind chill float.
    mockGetObservation.mockResolvedValueOnce({
      observation: {
        ...observationResult.observation,
        temperature: { value: 8.3, unitCode: 'wmoUnit:degC' },
        dewpoint: { value: 3.3, unitCode: 'wmoUnit:degC' },
        heatIndex: { value: 24.151, unitCode: 'wmoUnit:degC' },
        windChill: { value: 7.710126527509445, unitCode: 'wmoUnit:degC' },
      },
    });

    const result = await runToolContract(getObservationsTool, { station_id: 'KSEA' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      temperatureC: 8.3,
      dewpointC: 3.3,
      heatIndexC: 24.2,
      windChillC: 7.7,
    });
    const lines = result.content
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n')
      .split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        '**Temperature:** 47°F (8.3°C)',
        '**Dewpoint:** 38°F (3.3°C)',
        // °F is the conversion of the shown 24.2°C (75.56 → 76), not of the raw 24.151.
        '**Heat Index:** 76°F (24.2°C)',
        '**Wind Chill:** 46°F (7.7°C)',
      ]),
    );
  });

  it('returns precipitation amounts in mm on both surfaces, a 0 as a trace (issue #65)', async () => {
    // KSLC 2026-10-23T02:54Z (`P0013 60024`), then KSEA 2026-10-23T04:53Z (`P0000`).
    const mm = (value: number | null) => ({ value, unitCode: 'wmoUnit:mm' });
    mockGetObservation
      .mockResolvedValueOnce({
        observation: {
          ...observationResult.observation,
          precipitationLastHour: mm(3.3),
          precipitationLast3Hours: mm(6.1),
          precipitationLast6Hours: mm(null),
        },
      })
      .mockResolvedValueOnce({
        observation: {
          ...observationResult.observation,
          precipitationLastHour: mm(0),
          precipitationLast3Hours: mm(null),
          precipitationLast6Hours: mm(null),
        },
      });

    /** The Precipitation lines of a result's content[], each whole. */
    const precipitationLines = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n')
        .split('\n')
        .filter((line) => line.startsWith('**Precipitation:**'));

    const rain = await runToolContract(getObservationsTool, { station_id: 'KSLC' });
    expect(rain.structuredContent).toMatchObject({
      precipitationLastHourMm: 3.3,
      precipitationLast3HoursMm: 6.1,
      precipitationLast6HoursMm: null,
    });
    expect(precipitationLines(rain)).toEqual([
      '**Precipitation:** 1 h: 0.13 in (3.3 mm), 3 h: 0.24 in (6.1 mm)',
    ]);

    const trace = await runToolContract(getObservationsTool, { station_id: 'KSEA' });
    expect(trace.structuredContent).toMatchObject({
      precipitationLastHourMm: 0,
      precipitationLast3HoursMm: null,
      precipitationLast6HoursMm: null,
    });
    expect(precipitationLines(trace)).toEqual(['**Precipitation:** 1 h: Trace']);
  });

  it('returns null precipitation and no Precipitation line when no amount was reported', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const result = await runToolContract(getObservationsTool, { station_id: 'KSEA' });

    expect(result.structuredContent).toMatchObject({
      precipitationLastHourMm: null,
      precipitationLast3HoursMm: null,
      precipitationLast6HoursMm: null,
    });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).not.toContain('Precipitation');
  });

  it('preserves null measurements through rounding (does not coerce to 0)', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
    const input = getObservationsTool.input.parse({ station_id: 'KSEA' });
    const result = await getObservationsTool.handler(input, ctx);

    expect(result.windGustKmh).toBeNull();
    expect(result.heatIndexC).toBeNull();
    expect(result.windChillC).toBeNull();
  });

  it('trims station_id before calling the service', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
    const input = getObservationsTool.input.parse({ station_id: ' KSEA ' });
    await getObservationsTool.handler(input, ctx);

    expect(mockGetObservation).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'KSEA' }),
      ctx,
    );
  });

  it('returns observation data by coordinates', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
    const input = getObservationsTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    const result = await getObservationsTool.handler(input, ctx);

    expect(result.stationId).toBe('KSEA');
    expect(mockGetObservation).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 47.6, longitude: -122.3 }),
      ctx,
    );
  });

  it('treats a blank station_id as unset, resolving the nearest station from coordinates (issue #46)', async () => {
    // Form clients send the blank field alongside the coordinates they filled.
    // The response names the station it served, so the resolution stays visible.
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const result = await runToolContract(getObservationsTool, {
      station_id: '   ',
      latitude: 47.6062,
      longitude: -122.3321,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ stationId: 'KSEA', station: 'KSEA' });
    const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(text).toContain('**Station:** `KSEA`');
    expect(mockGetObservation).toHaveBeenCalledWith(
      { latitude: 47.6062, longitude: -122.3321, stationId: undefined },
      expect.anything(),
    );
  });

  it('throws when neither station_id nor coordinates provided', async () => {
    const result = await runToolContract(getObservationsTool, {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'missing_input',
          recovery: { hint: expect.stringContaining('station_id or both latitude and longitude') },
        },
      },
    });
  });

  it.each(['', '   '])(
    'raises missing_input for a blank station_id %j with no coordinates',
    async (stationId) => {
      // The blank is unset, so the call carries neither input.
      const result = await runToolContract(getObservationsTool, { station_id: stationId });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'missing_input',
            recovery: {
              hint: expect.stringContaining('station_id or both latitude and longitude'),
            },
          },
        },
      });
      expect(mockGetObservation).not.toHaveBeenCalled();
    },
  );

  it('resolves the nearest station when station_id is genuinely omitted', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
    const input = getObservationsTool.input.parse({ latitude: 47.6062, longitude: -122.3321 });
    const result = await getObservationsTool.handler(input, ctx);

    expect(result.stationId).toBe('KSEA');
    expect(mockGetObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        stationId: undefined,
        latitude: 47.6062,
        longitude: -122.3321,
      }),
      ctx,
    );
  });

  it('salvages a whitespace-padded station_id instead of rejecting it as blank', async () => {
    mockGetObservation.mockResolvedValueOnce(observationResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getObservationsTool.errors });
    const input = getObservationsTool.input.parse({ station_id: '  KSEA  ' });
    const result = await getObservationsTool.handler(input, ctx);

    expect(result.stationId).toBe('KSEA');
    expect(mockGetObservation).toHaveBeenCalledWith(
      expect.objectContaining({ stationId: 'KSEA' }),
      ctx,
    );
  });

  it('throws when only latitude provided', async () => {
    const result = await runToolContract(getObservationsTool, { latitude: 47.6 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'missing_input',
          recovery: { hint: expect.stringContaining('station_id or both latitude and longitude') },
        },
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
        precipitationLastHourMm: null,
        precipitationLast3HoursMm: null,
        precipitationLast6HoursMm: null,
        cloudLayers: [{ amount: 'BKN', baseM: 1524 }],
      };

      const blocks = getObservationsTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('KSEA');
      expect(text).toContain('Mostly Cloudy');
      // Should show both F and C, at the one-decimal Celsius precision it was given
      expect(text).toContain('**Temperature:** 58°F (14.4°C)');
      expect(text).toContain('**Dewpoint:** 47°F (8.3°C)');
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
        precipitationLastHourMm: null,
        precipitationLast3HoursMm: null,
        precipitationLast6HoursMm: null,
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
        precipitationLastHourMm: null,
        precipitationLast3HoursMm: null,
        precipitationLast6HoursMm: null,
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
