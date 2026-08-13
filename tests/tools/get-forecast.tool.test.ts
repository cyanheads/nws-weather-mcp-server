/**
 * @fileoverview Tests for nws_get_forecast tool.
 * @module tests/tools/get-forecast
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
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

/** Build a forecast result whose period array carries `count` distinguishable hourly periods. */
function hourlyForecast(count: number): ForecastResult {
  return {
    ...forecastResult,
    forecast: {
      ...forecastResult.forecast,
      periods: Array.from({ length: count }, (_, index) => ({
        ...forecastResult.forecast.periods[0]!,
        number: index + 1,
        name: '',
        shortForecast: `Hour ${index + 1} conditions`,
        detailedForecast: '',
      })),
    },
  };
}

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

    const ctx = createMockContext({ tenantId: 'test', errors: getForecastTool.errors });
    const input = getForecastTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    const result = await getForecastTool.handler(input, ctx);

    expect(result.location.city).toBe('Seattle');
    expect(result.location.forecastZone).toBe('WAZ558');
    expect(result.location.county).toBe('WAC033');
    expect(result.generatedAt).toBe('2026-04-03T12:00:00Z');
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0]!.name).toBe('Today');
    expect(result.periods[0]!.precipChancePct).toBe(10);
    expect(result.periods[0]!.dewpointC).toBe(8.5);
  });

  it('passes hourly flag to service', async () => {
    mockGetForecast.mockResolvedValueOnce(forecastResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getForecastTool.errors });
    const input = getForecastTool.input.parse({ latitude: 47.6, longitude: -122.3, hourly: true });
    await getForecastTool.handler(input, ctx);

    expect(mockGetForecast).toHaveBeenCalledWith(47.6, -122.3, true, ctx);
  });

  it('rejects latitude out of range', () => {
    expect(() => getForecastTool.input.parse({ latitude: 100, longitude: 0 })).toThrow();
  });

  describe('enrichment', () => {
    it('populates periodCount and mode on success (7-day)', async () => {
      mockGetForecast.mockResolvedValueOnce(forecastResult);

      const ctx = createMockContext({ tenantId: 'test', errors: getForecastTool.errors });
      const input = getForecastTool.input.parse({ latitude: 47.6, longitude: -122.3 });
      await getForecastTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment).toMatchObject({ periodCount: 1, totalPeriodCount: 1, mode: '7-day' });
      expect(enrichment.notice).toBeUndefined();
    });

    it('populates mode as "hourly" when hourly=true', async () => {
      mockGetForecast.mockResolvedValueOnce(forecastResult);

      const ctx = createMockContext({ tenantId: 'test', errors: getForecastTool.errors });
      const input = getForecastTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        hourly: true,
      });
      await getForecastTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment).toMatchObject({ mode: 'hourly' });
    });
  });

  describe('period cap (regression: issue #23)', () => {
    it('caps hourly periods at 48 in the handler so structuredContent matches format()', async () => {
      const hourlyResult: ForecastResult = {
        ...forecastResult,
        forecast: {
          ...forecastResult.forecast,
          periods: Array.from({ length: 156 }, (_, index) => ({
            ...forecastResult.forecast.periods[0]!,
            number: index + 1,
            name: '',
            shortForecast: `Hour ${index + 1} conditions`,
            detailedForecast: '',
          })),
        },
      };
      mockGetForecast.mockResolvedValueOnce(hourlyResult);

      const ctx = createMockContext({ tenantId: 'test', errors: getForecastTool.errors });
      const input = getForecastTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        hourly: true,
      });
      const result = await getForecastTool.handler(input, ctx);

      // The handler's returned periods populate structuredContent — capped at 48.
      expect(result.periods).toHaveLength(48);
      expect(result.periods[47]!.shortForecast).toBe('Hour 48 conditions');

      const enrichment = getEnrichment(ctx);
      expect(enrichment).toMatchObject({
        periodCount: 48,
        totalPeriodCount: 156,
        mode: 'hourly',
      });
      expect(enrichment.notice).toContain('first 48 of 156');
      // The 108 periods past the window are reachable, not merely disclosed.
      expect(enrichment.nextCursor).toEqual(expect.any(String));

      // format() consumes the same capped result — both surfaces share one projection.
      const blocks = getForecastTool.format!(result);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Hour 48 conditions');
      expect(text).not.toContain('Hour 49 conditions');
    });

    it('does not cap or notice when upstream returns 48 or fewer periods', async () => {
      const smallResult: ForecastResult = {
        ...forecastResult,
        forecast: {
          ...forecastResult.forecast,
          periods: Array.from({ length: 14 }, (_, index) => ({
            ...forecastResult.forecast.periods[0]!,
            number: index + 1,
            name: `Period ${index + 1}`,
          })),
        },
      };
      mockGetForecast.mockResolvedValueOnce(smallResult);

      const ctx = createMockContext({ tenantId: 'test', errors: getForecastTool.errors });
      const input = getForecastTool.input.parse({ latitude: 47.6, longitude: -122.3 });
      const result = await getForecastTool.handler(input, ctx);

      expect(result.periods).toHaveLength(14);

      const enrichment = getEnrichment(ctx);
      expect(enrichment).toMatchObject({ periodCount: 14, totalPeriodCount: 14 });
      expect(enrichment.notice).toBeUndefined();
    });
  });

  describe('cursor pagination (issue #27)', () => {
    /** Run one page against the currently mocked forecast and return output + enrichment. */
    async function page(cursor?: string) {
      const ctx = createMockContext({ tenantId: 'test', errors: getForecastTool.errors });
      const input = getForecastTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        hourly: true,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const result = await getForecastTool.handler(input, ctx);
      return { result, enrichment: getEnrichment(ctx) };
    }

    it('offers a nextCursor when periods remain beyond the first window', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(156));

      const { result, enrichment } = await page();

      expect(result.periods).toHaveLength(48);
      expect(enrichment.nextCursor).toEqual(expect.any(String));
      expect(enrichment.notice).toContain('cursor');
    });

    it('walks consecutive pages over one fetched array with no overlap and no gaps', async () => {
      // The mock returns the same period array on every call, so this proves the
      // windowing is contiguous over a single fetched collection. It does NOT
      // claim anything about two separate live fetches.
      mockGetForecast.mockResolvedValue(hourlyForecast(156));

      const seen: string[] = [];
      const pageSizes: number[] = [];
      let cursor: string | undefined;
      do {
        const { result, enrichment } = await page(cursor);
        seen.push(...result.periods.map((p) => p.shortForecast));
        pageSizes.push(result.periods.length);
        cursor = enrichment.nextCursor as string | undefined;
      } while (cursor);

      expect(pageSizes).toEqual([48, 48, 48, 12]);
      expect(seen).toEqual(
        Array.from({ length: 156 }, (_, index) => `Hour ${index + 1} conditions`),
      );
      expect(new Set(seen).size).toBe(156);
    });

    it('omits nextCursor entirely when every period fits one page', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(14));

      const { result, enrichment } = await page();

      expect(result.periods).toHaveLength(14);
      expect(enrichment).not.toHaveProperty('nextCursor');
    });

    it('omits nextCursor when the final page ends exactly on the array length', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(96));

      const first = await page();
      expect(first.enrichment.nextCursor).toEqual(expect.any(String));

      const second = await page(first.enrichment.nextCursor as string);
      expect(second.result.periods).toHaveLength(48);
      expect(second.result.periods[47]!.shortForecast).toBe('Hour 96 conditions');
      expect(second.enrichment).not.toHaveProperty('nextCursor');
    });

    it('returns an empty page for a cursor whose offset equals the array length', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(96));

      const { result, enrichment } = await page(encodeCursor({ offset: 96, limit: 48 }));

      expect(result.periods).toHaveLength(0);
      expect(enrichment.periodCount).toBe(0);
      expect(enrichment.totalPeriodCount).toBe(96);
      expect(enrichment).not.toHaveProperty('nextCursor');
      expect(enrichment.notice).toContain('past the end');
    });

    it('returns an empty page for a cursor past the end of the array', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(96));

      const { result, enrichment } = await page(encodeCursor({ offset: 500, limit: 48 }));

      expect(result.periods).toHaveLength(0);
      expect(enrichment).not.toHaveProperty('nextCursor');
      expect(enrichment.notice).toContain('past the end');
    });

    it('clamps an oversized cursor page size to the 48-period bound (contract: issue #23)', async () => {
      // The cursor is opaque but forgeable. A larger encoded limit must not widen
      // the projection structuredContent and format() share.
      mockGetForecast.mockResolvedValue(hourlyForecast(156));

      const { result, enrichment } = await page(encodeCursor({ offset: 0, limit: 1000 }));

      expect(result.periods).toHaveLength(48);
      expect(enrichment.periodCount).toBe(48);
      expect(getForecastTool.format!(result)[0]).toMatchObject({
        text: expect.not.stringContaining('Hour 49 conditions'),
      });
    });

    it('rejects a malformed cursor with InvalidParams (-32602), per the MCP pagination spec', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(156));

      const ctx = createMockContext({ tenantId: 'test', errors: getForecastTool.errors });
      const input = getForecastTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        hourly: true,
        cursor: 'not-a-real-cursor',
      });

      await expect(getForecastTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
      });
    });

    it('treats an empty-string cursor as the first page (form-based clients)', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(156));

      const { result, enrichment } = await page('');

      expect(result.periods[0]!.shortForecast).toBe('Hour 1 conditions');
      expect(enrichment.periodCount).toBe(48);
    });

    it('renders the cursor-selected window in format(), not the first window', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(156));

      const first = await page();
      const second = await page(first.enrichment.nextCursor as string);

      const blocks = getForecastTool.format!(second.result);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Hour 49 conditions');
      expect(text).toContain('Hour 96 conditions');
      expect(text).not.toContain('Hour 48 conditions');
      expect(text).not.toContain('Hour 97 conditions');
    });
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
            precipChancePct: 10,
            dewpointC: 8.5,
            relativeHumidityPct: 55,
          },
        ],
      };

      const blocks = getForecastTool.format!(output);
      expect(blocks[0]!.type).toBe('text');
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
            precipChancePct: 0,
            dewpointC: 8.5,
            relativeHumidityPct: 75,
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
            precipChancePct: null,
            dewpointC: null,
            relativeHumidityPct: null,
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
            precipChancePct: null,
            dewpointC: null,
            relativeHumidityPct: null,
          },
        ],
      };

      const blocks = getForecastTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('### Tonight');
    });

    it('renders every period it receives — truncation happens in the handler', () => {
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
          precipChancePct: null,
          dewpointC: null,
          relativeHumidityPct: null,
        })),
      };

      const blocks = getForecastTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Short forecast 1');
      expect(text).toContain('Short forecast 49');
      expect(text).not.toContain('more periods');
    });
  });
});
