/**
 * @fileoverview Tests for nws_get_forecast tool.
 * @module tests/tools/get-forecast
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForecastResult } from '@/services/nws/nws-service.js';

const mockGetForecast = vi.fn<() => Promise<ForecastResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ getForecast: mockGetForecast }),
}));

const { getForecastTool } = await import('@/mcp-server/tools/definitions/get-forecast.tool.js');

const forecastResult: ForecastResult = {
  location: { city: 'Seattle', state: 'WA', office: 'SEW', timeZone: 'America/Los_Angeles' },
  forecast: {
    generatedAt: '2026-04-03T12:00:00Z',
    updateTime: '2026-04-03T12:00:00Z',
    periods: [
      {
        number: 1,
        name: 'Today',
        startTime: '2026-04-03T06:00:00-07:00',
        endTime: '2026-04-03T18:00:00-07:00',
        isDaytime: true,
        temperature: 62,
        temperatureUnit: 'F',
        windSpeed: '10 mph',
        windDirection: 'NW',
        shortForecast: 'Mostly Sunny',
        detailedForecast: 'Mostly sunny, with a high near 62.',
        probabilityOfPrecipitation: { value: 10, unitCode: 'wmoUnit:percent' },
        dewpoint: { value: 8.5, unitCode: 'wmoUnit:degC' },
        relativeHumidity: { value: 55, unitCode: 'wmoUnit:percent' },
      },
    ],
  },
};

describe('nws_get_forecast', () => {
  beforeEach(() => {
    mockGetForecast.mockReset();
  });

  it('parses valid input', () => {
    const input = getForecastTool.input.parse({
      latitude: 47.6062,
      longitude: -122.3321,
    });
    expect(input.latitude).toBe(47.6062);
    expect(input.hourly).toBe(false);
  });

  it('returns forecast periods', async () => {
    mockGetForecast.mockResolvedValueOnce(forecastResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getForecastTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    const result = await getForecastTool.handler(input, ctx);

    expect(result.location.city).toBe('Seattle');
    expect(result.generatedAt).toBe('2026-04-03T12:00:00Z');
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0].name).toBe('Today');
    expect(result.periods[0].precipChance).toBe(10);
    expect(result.periods[0].dewpoint).toBe(8.5);
  });

  it('passes hourly flag to service', async () => {
    mockGetForecast.mockResolvedValueOnce(forecastResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getForecastTool.input.parse({ latitude: 47.6, longitude: -122.3, hourly: true });
    await getForecastTool.handler(input, ctx);

    expect(mockGetForecast).toHaveBeenCalledWith(47.6, -122.3, true, ctx);
  });

  it('rejects latitude out of range', () => {
    expect(() => getForecastTool.input.parse({ latitude: 100, longitude: 0 })).toThrow();
  });

  describe('format', () => {
    it('renders forecast markdown', () => {
      mockGetForecast.mockResolvedValueOnce(forecastResult);

      const output = {
        location: { city: 'Seattle', state: 'WA', office: 'SEW', timeZone: 'America/Los_Angeles' },
        generatedAt: '2026-04-03T12:00:00Z',
        periods: [
          {
            name: 'Today',
            startTime: '2026-04-03T06:00:00-07:00',
            endTime: '2026-04-03T18:00:00-07:00',
            temperature: 62,
            temperatureUnit: 'F',
            windSpeed: '10 mph',
            windDirection: 'NW',
            shortForecast: 'Mostly Sunny',
            detailedForecast: 'Mostly sunny, high near 62.',
            precipChance: 10,
            dewpoint: 8.5,
            relativeHumidity: 55,
          },
        ],
      };

      const blocks = getForecastTool.format!(output);
      expect(blocks[0].type).toBe('text');
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Seattle, WA');
      expect(text).toContain('Today');
      expect(text).toContain('62°F');
      expect(text).toContain('Precip');
    });
  });
});
