/**
 * @fileoverview Tests for nws_get_forecast tool.
 * @module tests/tools/get-forecast
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

type ForecastPeriodFixture = ForecastResult['forecast']['periods'][number];

/** One upstream hourly period: empty `name`, metric dewpoint and humidity as NWS ships them. */
function hourlyPeriod(
  number: number,
  startTime: string,
  temperature: number,
  dewpointC: number | null,
  shortForecast: string,
): ForecastPeriodFixture {
  const start = new Date(startTime);
  return {
    number,
    name: '',
    startTime,
    endTime: new Date(start.getTime() + 3_600_000).toISOString(),
    isDaytime: true,
    temperature,
    temperatureUnit: 'F',
    windSpeed: '2 mph',
    windDirection: 'S',
    shortForecast,
    detailedForecast: '',
    probabilityOfPrecipitation: { value: 0, unitCode: 'wmoUnit:percent' },
    dewpoint: { value: dewpointC, unitCode: 'wmoUnit:degC' },
    relativeHumidity: { value: 69, unitCode: 'wmoUnit:percent' },
  };
}

/**
 * Seattle hourly periods as `/gridpoints/SEW/.../forecast/hourly` returned them on
 * 2026-10-16: NWS ships each dewpoint as the Celsius conversion of a whole °F value.
 */
const seattleHourly: ForecastResult = {
  location: forecastResult.location,
  forecast: {
    generatedAt: '2026-10-16T13:50:39+00:00',
    updateTime: '2026-10-16T06:26:45+00:00',
    periods: [
      hourlyPeriod(1, '2026-10-16T06:00:00-07:00', 53, 6.111111111111111, 'Mostly Sunny'),
      hourlyPeriod(2, '2026-10-16T07:00:00-07:00', 53, 6.111111111111111, 'Partly Sunny'),
      hourlyPeriod(4, '2026-10-16T09:00:00-07:00', 55, 6.666666666666667, 'Partly Sunny'),
      hourlyPeriod(11, '2026-10-16T16:00:00-07:00', 73, 9.444444444444445, 'Mostly Sunny'),
    ],
  },
};

/** Text of every content block of a contract-run success result. */
function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  expect(result.isError).toBeFalsy();
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n');
}

type StructuredPeriod = { name: string; shortForecast: string; dewpointC: number | null };

/** Run the tool through its contract boundary and return both surfaces. */
async function runForecast(result: ForecastResult, hourly: boolean) {
  mockGetForecast.mockResolvedValue(result);
  const run = await runToolContract(getForecastTool, {
    latitude: 47.6062,
    longitude: -122.3321,
    hourly,
  });
  const periods = (run.structuredContent as { periods: StructuredPeriod[] }).periods;
  return { periods, text: contentText(run) };
}

/** Escape a literal for use inside a RegExp. */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('nws_get_forecast', () => {
  beforeEach(() => {
    mockGetForecast.mockReset();
  });

  describe('surface parity (issue #52)', () => {
    it('derives each hourly name into structuredContent, equal to its content[] header', async () => {
      const { periods, text } = await runForecast(seattleHourly, true);

      expect(periods.map((p) => p.name)).toEqual([
        'Fri 6:00 AM',
        'Fri 7:00 AM',
        'Fri 9:00 AM',
        'Fri 4:00 PM',
      ]);
      for (const p of periods) {
        expect(text).toMatch(
          new RegExp(`^### ${escapeRegExp(p.name)} — ${escapeRegExp(p.shortForecast)}$`, 'm'),
        );
      }
    });

    it('renders each dewpoint Celsius at the structured precision, °F derived from it', async () => {
      const { periods, text } = await runForecast(seattleHourly, true);

      // structuredContent keeps tenths of a degree.
      expect(periods.map((p) => p.dewpointC)).toEqual([6.1, 6.1, 6.7, 9.4]);
      // content[] renders one dewpoint per period, ending its line, at that precision.
      const dewpoints = text
        .split('\n')
        .filter((line) => line.includes('**Dewpoint:**'))
        .map((line) => line.slice(line.indexOf('**Dewpoint:**')));
      expect(dewpoints).toEqual([
        '**Dewpoint:** 43°F (6.1°C)',
        '**Dewpoint:** 43°F (6.1°C)',
        '**Dewpoint:** 44°F (6.7°C)',
        '**Dewpoint:** 49°F (9.4°C)',
      ]);
    });

    it('labels hourly periods identically whatever the host TZ', async () => {
      const originalTz = process.env.TZ;
      const labels: string[][] = [];
      try {
        for (const tz of ['UTC', 'Asia/Tokyo', 'America/New_York']) {
          process.env.TZ = tz;
          const { periods } = await runForecast(seattleHourly, true);
          labels.push(periods.map((p) => p.name));
        }
      } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
      }

      expect(labels).toEqual(
        Array(3).fill(['Fri 6:00 AM', 'Fri 7:00 AM', 'Fri 9:00 AM', 'Fri 4:00 PM']),
      );
    });

    it('keeps upstream names on the 7-day forecast and renders no dewpoint when it is null', async () => {
      const sevenDay: ForecastResult = {
        ...forecastResult,
        forecast: {
          ...forecastResult.forecast,
          periods: [
            {
              ...forecastResult.forecast.periods[0]!,
              dewpoint: { value: null, unitCode: 'wmoUnit:degC' },
            },
            {
              ...forecastResult.forecast.periods[0]!,
              number: 2,
              name: 'Tonight',
              startTime: '2026-04-03T18:00:00-07:00',
              endTime: '2026-04-04T06:00:00-07:00',
              shortForecast: 'Mostly Clear',
              dewpoint: { value: null, unitCode: 'wmoUnit:degC' },
            },
          ],
        },
      };

      const { periods, text } = await runForecast(sevenDay, false);

      expect(periods.map((p) => p.name)).toEqual(['Today', 'Tonight']);
      expect(periods.map((p) => p.dewpointC)).toEqual([null, null]);
      expect(text).toMatch(/^### Today — Mostly Sunny$/m);
      expect(text).toMatch(/^### Tonight — Mostly Clear$/m);
      expect(text).not.toContain('Dewpoint');
    });

    it('labels hours in the forecast location TZ, not UTC (regression: issue #6)', async () => {
      // 15:00 UTC = 8:00 AM PDT.
      const { periods, text } = await runForecast(
        {
          ...seattleHourly,
          forecast: {
            ...seattleHourly.forecast,
            periods: [hourlyPeriod(1, '2026-04-19T15:00:00Z', 51, 8.5, 'Cloudy')],
          },
        },
        true,
      );

      expect(periods[0]!.name).toBe('Sun 8:00 AM');
      expect(text).toMatch(/^### Sun 8:00 AM — Cloudy$/m);
      expect(text).not.toMatch(/^### Sun 3:00 PM/m);
    });

    it('labels hours consistently with the time range rendered below them', async () => {
      // 18:00 UTC = 2:00 PM EDT.
      const { periods, text } = await runForecast(
        {
          location: {
            ...forecastResult.location,
            city: 'Boston',
            state: 'MA',
            timeZone: 'America/New_York',
          },
          forecast: {
            ...seattleHourly.forecast,
            periods: [hourlyPeriod(1, '2026-07-04T18:00:00Z', 78, null, 'Sunny')],
          },
        },
        true,
      );

      expect(periods[0]!.name).toBe('Sat 2:00 PM');
      // The header and the range line directly below it name the same hour.
      expect(text).toMatch(
        /^### Sat 2:00 PM — Sunny\n_[^\n]*\b2:00 PM EDT → [^\n]*\b3:00 PM EDT_$/m,
      );
    });
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
    it('populates the period counts and mode on success (7-day)', async () => {
      mockGetForecast.mockResolvedValueOnce(forecastResult);

      const ctx = createMockContext({ tenantId: 'test', errors: getForecastTool.errors });
      const input = getForecastTool.input.parse({ latitude: 47.6, longitude: -122.3 });
      await getForecastTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment).toMatchObject({ shown: 1, totalCount: 1, mode: '7-day' });
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
        shown: 48,
        totalCount: 156,
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
      expect(enrichment).toMatchObject({ shown: 14, totalCount: 14 });
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
      expect(enrichment.shown).toBe(0);
      expect(enrichment.totalCount).toBe(96);
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
      expect(enrichment.shown).toBe(48);
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
      expect(enrichment.shown).toBe(48);
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
