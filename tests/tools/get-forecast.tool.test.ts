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
  location: {
    city: 'Seattle',
    state: 'WA',
    office: 'SEW',
    timeZone: 'America/Los_Angeles',
    forecastZone: 'WAZ558',
    county: 'WAC033',
  },
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
    expect(result.location.forecastZone).toBe('WAZ558');
    expect(result.location.county).toBe('WAC033');
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
        location: {
          city: 'Seattle',
          state: 'WA',
          office: 'SEW',
          timeZone: 'America/Los_Angeles',
          forecastZone: 'WAZ558',
          county: 'WAC033',
        },
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
      expect(text).toContain('Forecast Zone:** WAZ558');
      expect(text).toContain('County Zone:** WAC033');
      expect(text).toContain('Today');
      expect(text).toContain('62°F');
      expect(text).toContain('Precip');
    });

    it('renders a helpful message when no forecast periods are available', () => {
      const output = {
        location: {
          city: 'Seattle',
          state: 'WA',
          office: 'SEW',
          timeZone: 'America/Los_Angeles',
          forecastZone: 'WAZ558',
          county: 'WAC033',
        },
        generatedAt: '2026-04-03T12:00:00Z',
        periods: [],
      };

      const blocks = getForecastTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No forecast periods available for this location.');
    });

    it('renders hourly period headers in the forecast location TZ (regression: issue #6)', () => {
      // 15:00 UTC = 8:00 AM PDT — header should reflect PDT, not the host's TZ.
      // When `name` is empty (hourly periods), the label is derived from startTime.
      const output = {
        location: {
          city: 'Seattle',
          state: 'WA',
          office: 'SEW',
          timeZone: 'America/Los_Angeles',
          forecastZone: 'WAZ558',
          county: 'WAC033',
        },
        generatedAt: '2026-04-19T12:00:00Z',
        periods: [
          {
            name: '', // empty name → triggers periodLabel() derivation
            startTime: '2026-04-19T15:00:00Z',
            endTime: '2026-04-19T16:00:00Z',
            temperature: 51,
            temperatureUnit: 'F',
            windSpeed: '2 mph',
            windDirection: 'N',
            shortForecast: 'Cloudy',
            detailedForecast: '',
            precipChance: 0,
            dewpoint: 8.5,
            relativeHumidity: 75,
          },
        ],
      };

      const blocks = getForecastTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      // Header should be "Sun 8:00 AM" (PDT), not "Sun 3:00 PM" (UTC) or
      // anything from the host TZ. Match the header line precisely so it's
      // resilient to any unrelated formatter changes.
      expect(text).toMatch(/^### Sun 8:00 AM — /m);
      expect(text).not.toMatch(/^### Sun 3:00 PM$/m);
    });

    it('renders hourly headers consistently with the time range below them', () => {
      // The header and the range line below it should agree on the time. Before
      // the fix they disagreed by the host-vs-location TZ delta.
      const output = {
        location: {
          city: 'Boston',
          state: 'MA',
          office: 'BOX',
          timeZone: 'America/New_York',
          forecastZone: 'MAZ014',
          county: 'MAC025',
        },
        generatedAt: '2026-07-04T12:00:00Z',
        periods: [
          {
            name: '',
            startTime: '2026-07-04T18:00:00Z', // 2:00 PM EDT
            endTime: '2026-07-04T19:00:00Z',
            temperature: 78,
            temperatureUnit: 'F',
            windSpeed: '5 mph',
            windDirection: 'SW',
            shortForecast: 'Sunny',
            detailedForecast: '',
            precipChance: null,
            dewpoint: null,
            relativeHumidity: null,
          },
        ],
      };

      const blocks = getForecastTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      // Header should match the start time of the range (2:00 PM EDT).
      expect(text).toContain('### Sat 2:00 PM');
      expect(text).toContain('2:00 PM EDT → ');
    });

    it('preserves NWS-supplied named periods on the standard 12-hour forecast', () => {
      // Sanity: when name is non-empty (standard forecast), we use it verbatim
      // and the time-zone fix does not apply. Verifies the bug fix didn't
      // regress the default forecast path.
      const output = {
        location: {
          city: 'Seattle',
          state: 'WA',
          office: 'SEW',
          timeZone: 'America/Los_Angeles',
          forecastZone: 'WAZ558',
          county: 'WAC033',
        },
        generatedAt: '2026-04-03T12:00:00Z',
        periods: [
          {
            name: 'Tonight',
            startTime: '2026-04-03T18:00:00-07:00',
            endTime: '2026-04-04T06:00:00-07:00',
            temperature: 48,
            temperatureUnit: 'F',
            windSpeed: '5 mph',
            windDirection: 'S',
            shortForecast: 'Mostly Clear',
            detailedForecast: 'Mostly clear with a low near 48.',
            precipChance: null,
            dewpoint: null,
            relativeHumidity: null,
          },
        ],
      };

      const blocks = getForecastTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('### Tonight');
    });

    it('falls back to the short forecast and notes omitted periods', () => {
      const output = {
        location: {
          city: 'Seattle',
          state: 'WA',
          office: 'SEW',
          timeZone: 'America/Los_Angeles',
          forecastZone: 'WAZ558',
          county: 'WAC033',
        },
        generatedAt: '2026-04-03T12:00:00Z',
        periods: Array.from({ length: 49 }, (_, index) => ({
          name: `Period ${index + 1}`,
          startTime: '2026-04-03T06:00:00-07:00',
          endTime: '2026-04-03T07:00:00-07:00',
          temperature: 62,
          temperatureUnit: 'F',
          windSpeed: '10 mph',
          windDirection: 'NW',
          shortForecast: `Short forecast ${index + 1}`,
          detailedForecast: index === 0 ? '' : `Detailed forecast ${index + 1}`,
          precipChance: null,
          dewpoint: null,
          relativeHumidity: null,
        })),
      };

      const blocks = getForecastTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Short forecast 1');
      expect(text).toContain('...and 1 more periods (49 total).');
    });
  });
});
