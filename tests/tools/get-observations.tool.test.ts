/**
 * @fileoverview Tests for nws_get_observations tool.
 * @module tests/tools/get-observations
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservationResult } from '@/services/nws/nws-service.js';

const mockGetObservation = vi.fn<() => Promise<ObservationResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ getObservation: mockGetObservation }),
}));

const { getObservationsTool } = await import(
  '@/mcp-server/tools/definitions/get-observations.tool.js'
);

const observationResult: ObservationResult = {
  observation: {
    stationId: 'KSEA',
    stationName: 'Seattle-Tacoma International Airport',
    timestamp: '2026-04-03T11:53:00+00:00',
    timeZone: 'America/Los_Angeles',
    textDescription: 'Mostly Cloudy',
    temperature: { value: 14.4, unitCode: 'wmoUnit:degC' },
    dewpoint: { value: 8.3, unitCode: 'wmoUnit:degC' },
    windSpeed: { value: 18.5, unitCode: 'wmoUnit:km_h-1' },
    windDirection: { value: 200, unitCode: 'wmoUnit:degree_(angle)' },
    windGust: { value: null, unitCode: 'wmoUnit:km_h-1' },
    barometricPressure: { value: 101325, unitCode: 'wmoUnit:Pa' },
    visibility: { value: 16093, unitCode: 'wmoUnit:m' },
    relativeHumidity: { value: 65.2, unitCode: 'wmoUnit:percent' },
    heatIndex: { value: null, unitCode: 'wmoUnit:degC' },
    windChill: { value: null, unitCode: 'wmoUnit:degC' },
    cloudLayers: [{ base: { value: 1524, unitCode: 'wmoUnit:m' }, amount: 'BKN' }],
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
    expect(result.temperature).toBe(14.4);
    expect(result.textDescription).toBe('Mostly Cloudy');
    expect(result.windGust).toBeNull();
    expect(result.cloudLayers).toHaveLength(1);
    expect(result.cloudLayers[0].amount).toBe('BKN');
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

  it('throws when neither station_id nor coordinates provided', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = getObservationsTool.input.parse({});
    const result = getObservationsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    await expect(result).rejects.toThrow(
      'Provide either station_id or both latitude and longitude',
    );
  });

  it('throws when only latitude provided', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = getObservationsTool.input.parse({ latitude: 47.6 });
    const result = getObservationsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    await expect(result).rejects.toThrow(
      'Provide either station_id or both latitude and longitude',
    );
  });

  describe('format', () => {
    it('renders observation with unit conversions', () => {
      const output = {
        stationId: 'KSEA',
        stationName: 'Seattle-Tacoma International Airport',
        timestamp: '2026-04-03T11:53:00+00:00',
        timeZone: 'America/Los_Angeles',
        textDescription: 'Mostly Cloudy',
        temperature: 14.4,
        dewpoint: 8.3,
        windSpeed: 18.5,
        windDirection: 200,
        windGust: null,
        barometricPressure: 101325,
        visibility: 16093,
        relativeHumidity: 65.2,
        heatIndex: null,
        windChill: null,
        cloudLayers: [{ amount: 'BKN', base: 1524 }],
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

    it('handles null values gracefully', () => {
      const output = {
        stationId: 'KSEA',
        stationName: 'KSEA',
        timestamp: '2026-04-03T06:00:00-10:00',
        timeZone: 'Pacific/Honolulu',
        textDescription: 'Clear',
        temperature: null,
        dewpoint: null,
        windSpeed: null,
        windDirection: null,
        windGust: null,
        barometricPressure: null,
        visibility: null,
        relativeHumidity: null,
        heatIndex: null,
        windChill: null,
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
