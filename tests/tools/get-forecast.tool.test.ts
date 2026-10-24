/**
 * @fileoverview Tests for nws_get_forecast tool.
 * @module tests/tools/get-forecast
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForecastResult } from '@/services/nws/nws-service.js';
import { pointsResponse } from '../fixtures/nws-responses.js';

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

describe('opt-in native amounts', () => {
  it('fails loudly when an amount result lacks its required timestamp-or-null field', async () => {
    mockGetForecast.mockResolvedValueOnce({ ...forecastResult, precipitationAmounts: [] });
    const input = getForecastTool.input.parse({
      latitude: 47.6,
      longitude: -122.3,
      include_amounts: true,
    });
    const result = await getForecastTool.handler(
      input,
      createMockContext({ errors: getForecastTool.errors }),
    );
    expect(() => getForecastTool.format!(result)).toThrow(
      'Precipitation amounts require amountsUpdateTime',
    );
  });
  it('renders every native interval and null metadata even with no forecast periods', async () => {
    mockGetForecast.mockResolvedValueOnce({
      ...forecastResult,
      forecast: { ...forecastResult.forecast, periods: [] },
      precipitationAmounts: [
        {
          layer: 'quantitativePrecipitation',
          uom: null,
          values: [
            { validTime: 'P1M/NOW', value: null },
            { validTime: '2026-04-03T00:00:00Z/P1D', value: 0 },
          ],
        },
        { layer: 'snowfallAmount', uom: 'wmoUnit:mm', values: [] },
      ],
      amountsUpdateTime: null,
    });
    const result = await runToolContract(getForecastTool, {
      latitude: 47.6,
      longitude: -122.3,
      include_amounts: true,
    });
    expect(result.structuredContent).toMatchObject({
      amountsUpdateTime: null,
      precipitationAmounts: [
        {
          layer: 'quantitativePrecipitation',
          uom: null,
          values: [
            { validTime: 'P1M/NOW', value: null },
            { validTime: '2026-04-03T00:00:00Z/P1D', value: 0 },
          ],
        },
        { layer: 'snowfallAmount', uom: 'wmoUnit:mm', values: [] },
      ],
    });
    const text = contentText(result);
    expect(text).toContain('P1M/NOW');
    expect(text).toContain('2026-04-03T00:00:00Z/P1D');
    expect(text).toContain('snowfallAmount');
    expect(text).toContain('null');
    expect(mockGetForecast).toHaveBeenLastCalledWith(47.6, -122.3, false, expect.anything(), true);
  });
});

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

/**
 * The clock the mocked-service cases run at: one hour after `forecastResult`'s
 * `updateTime`, so a grid-age notice appears only where a case sets one up.
 */
const FIXTURE_NOW = '2026-04-03T13:00:00Z';

describe('nws_get_forecast', () => {
  beforeEach(() => {
    mockGetForecast.mockReset();
    // Only Date is faked: promise scheduling and setTimeout stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXTURE_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it.each([
      ['an empty-string', ''],
      ['a whitespace-only', '  \t'],
    ])('treats %s cursor as the first page (form-based clients)', async (_label, cursor) => {
      mockGetForecast.mockResolvedValue(hourlyForecast(156));

      const { result, enrichment } = await page(cursor);

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

    it('words the first-page and continued-page paging notices exactly', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(156));

      const first = await page();
      const second = await page(first.enrichment.nextCursor as string);
      const third = await page(second.enrichment.nextCursor as string);
      const last = await page(third.enrichment.nextCursor as string);

      expect(first.enrichment.notice).toBe(
        'Returning the first 48 of 156 forecast periods to bound response size. Pass nextCursor back as cursor for the next window. Periods are contiguous within one response; NWS reissues forecasts through the day, so a later call can window a regenerated array.',
      );
      expect(second.enrichment.notice).toBe(
        'Returning 48 more of 156 forecast periods. Pass nextCursor back as cursor for the next window. Periods are contiguous within one response; NWS reissues forecasts through the day, so a later call can window a regenerated array.',
      );
      expect(last.result.periods).toHaveLength(12);
      expect(last.enrichment.notice).toBeUndefined();
    });
  });

  describe('grid updateTime and stale-forecast notice (issue #68)', () => {
    const HOUR_MS = 3_600_000;
    const PAGING_FIRST =
      'Returning the first 48 of 156 forecast periods to bound response size. Pass nextCursor back as cursor for the next window. Periods are contiguous within one response; NWS reissues forecasts through the day, so a later call can window a regenerated array.';

    /** Set the clock `hours` after `forecastResult`'s updateTime. */
    function hoursAfterUpdate(hours: number) {
      vi.setSystemTime(new Date(Date.parse(forecastResult.forecast.updateTime!) + hours * HOUR_MS));
    }

    async function run(result: ForecastResult, args: Record<string, unknown> = {}) {
      mockGetForecast.mockResolvedValue(result);
      const contract = await runToolContract(getForecastTool, {
        latitude: 47.6062,
        longitude: -122.3321,
        ...args,
      });
      return {
        data: contract.structuredContent as {
          updateTime: string | null;
          generatedAt: string;
          notice?: string;
        },
        text: contentText(contract),
      };
    }

    it('returns updateTime beside generatedAt on both surfaces', async () => {
      const { data, text } = await run({
        ...forecastResult,
        forecast: { ...forecastResult.forecast, updateTime: '2026-04-03T11:15:00Z' },
      });

      expect(data.updateTime).toBe('2026-04-03T11:15:00Z');
      expect(data.generatedAt).toBe('2026-04-03T12:00:00Z');
      // Both instants in Seattle time. ICU joins date and time with ", " on Node and
      // " at " on Bun, so the pattern takes either.
      expect(text).toMatch(
        /^\*\*Generated:\*\* Fri, Apr 3(?:,| at) 5:00\sAM PDT \| \*\*Updated:\*\* Fri, Apr 3(?:,| at) 4:15\sAM PDT$/m,
      );
    });

    it('gives no stale notice 23.9 hours after the update', async () => {
      hoursAfterUpdate(23.9);

      const { data, text } = await run(forecastResult);

      expect(data.notice).toBeUndefined();
      expect(text).not.toContain('last updated');
    });

    it('flags a grid not updated for 24.1 hours, with its age, on both surfaces', async () => {
      hoursAfterUpdate(24.1);

      const { data, text } = await run(forecastResult);

      const stale =
        'Forecast data was last updated 24.1h ago — NWS may have stopped updating this grid, so these periods may be out of date.';
      expect(data.notice).toBe(stale);
      expect(text).toContain(stale);
    });

    it('serves a grid NWS sent without updateTime, with updateTime null and no stale notice', async () => {
      hoursAfterUpdate(48);

      const { data, text } = await run({
        ...forecastResult,
        forecast: { ...forecastResult.forecast, updateTime: null },
      });

      expect(data.updateTime).toBeNull();
      expect(data.notice).toBeUndefined();
      expect(text).toContain('| **Updated:** not reported');
    });

    it('composes the stale sentence with the paging sentence on an hourly page with nextCursor', async () => {
      hoursAfterUpdate(30);

      const { data } = await run(hourlyForecast(156), { hourly: true });

      expect(data.notice).toBe(
        `Forecast data was last updated 30h ago — NWS may have stopped updating this grid, so these periods may be out of date. ${PAGING_FIRST}`,
      );
    });

    it('composes the stale sentence with the past-end sentence', async () => {
      hoursAfterUpdate(48.25);

      const { data } = await run(hourlyForecast(156), {
        cursor: encodeCursor({ offset: 156, limit: 48, hourly: true }),
      });

      expect(data.notice).toBe(
        "Forecast data was last updated 48.3h ago — NWS may have stopped updating this grid, so these periods may be out of date. The cursor points past the end of this hourly forecast's 156 periods. Call again with hourly: true and no cursor to restart from the first hourly period.",
      );
    });

    it('describes generatedAt, updateTime, and notice by what NWS defines them as', () => {
      const output = getForecastTool.output.shape;
      expect(output.generatedAt.description).toMatch(/when NWS generated this response/i);
      expect(output.updateTime.description).toMatch(
        /when the data this forecast was generated from was last updated/i,
      );
      expect(getForecastTool.enrichment?.notice?.description).toMatch(/more than 24 hours ago/);
    });
  });

  describe('cursor mode (issue #70)', () => {
    /** One page with `hourly` sent as given (omitted when undefined). */
    async function pageIn(hourly: boolean | undefined, cursor: string) {
      const ctx = createMockContext({ tenantId: 'test', errors: getForecastTool.errors });
      const input = getForecastTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        cursor,
        ...(hourly === undefined ? {} : { hourly }),
      });
      const result = await getForecastTool.handler(input, ctx);
      return { result, enrichment: getEnrichment(ctx) };
    }

    it('continues a 0.11.0 token ({offset, limit}) in the mode the hourly input names', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(156));

      const { result, enrichment } = await pageIn(true, encodeCursor({ offset: 48, limit: 48 }));

      expect(mockGetForecast).toHaveBeenCalledWith(47.6, -122.3, true, expect.anything());
      expect(result.periods.map((p) => p.shortForecast)).toEqual(
        Array.from({ length: 48 }, (_, index) => `Hour ${index + 49} conditions`),
      );
      expect(enrichment).toMatchObject({ mode: 'hourly', shown: 48, totalCount: 156 });
      // The re-minted token names the mode the page was served in, so the next page
      // stays hourly even if the caller drops hourly.
      expect(decodeCursor(enrichment.nextCursor as string, createMockContext())).toEqual({
        offset: 96,
        limit: 48,
        hourly: true,
      });
    });

    it('reads a 0.11.0 token sent without hourly against the 7-day forecast, as 0.11.0 did', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(14));

      const { result, enrichment } = await pageIn(
        undefined,
        encodeCursor({ offset: 2, limit: 48 }),
      );

      expect(mockGetForecast).toHaveBeenCalledWith(47.6, -122.3, false, expect.anything());
      expect(result.periods.map((p) => p.shortForecast)[0]).toBe('Hour 3 conditions');
      expect(enrichment).toMatchObject({ mode: '7-day', shown: 12, totalCount: 14 });
    });

    it('holds a page past the end of an hourly forecast to an hourly restart', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(156));

      const { result, enrichment } = await pageIn(
        undefined,
        encodeCursor({ offset: 156, limit: 48, hourly: true }),
      );

      expect(mockGetForecast).toHaveBeenCalledWith(47.6, -122.3, true, expect.anything());
      expect(result.periods).toHaveLength(0);
      expect(enrichment).toMatchObject({ mode: 'hourly', shown: 0, totalCount: 156 });
      expect(enrichment).not.toHaveProperty('nextCursor');
      expect(enrichment.notice).toBe(
        "The cursor points past the end of this hourly forecast's 156 periods. Call again with hourly: true and no cursor to restart from the first hourly period.",
      );
    });

    it('holds a page past the end of a 7-day forecast to a 7-day restart', async () => {
      mockGetForecast.mockResolvedValue(hourlyForecast(14));

      const { enrichment } = await pageIn(
        true,
        encodeCursor({ offset: 14, limit: 48, hourly: false }),
      );

      expect(mockGetForecast).toHaveBeenCalledWith(47.6, -122.3, false, expect.anything());
      expect(enrichment).toMatchObject({ mode: '7-day', shown: 0, totalCount: 14 });
      expect(enrichment.notice).toBe(
        "The cursor points past the end of this 7-day forecast's 14 periods. Call again with no cursor and hourly omitted or false to restart from the first 7-day period.",
      );
    });

    it('describes the cursor as carrying its mode', () => {
      const shape = getForecastTool.input.shape;
      expect(shape.cursor.description).toMatch(/carries the mode/i);
      expect(shape.hourly.description).toMatch(/cursor/i);
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
        updateTime: '2026-04-03T11:15:00Z',
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
        updateTime: '2026-04-03T11:15:00Z',
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
        updateTime: '2026-04-03T11:15:00Z',
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
        updateTime: '2026-04-03T11:15:00Z',
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

// ---------------------------------------------------------------------------
// Real NWS service over a strict fetch fake: which grid URL a page requests,
// and whether a cursor fails before any request.
// ---------------------------------------------------------------------------

const API = 'https://api.weather.gov';
const POINTS_URL = `${API}/points/47.6062,-122.3321`;
const DAILY_URL = pointsResponse.properties.forecast;
const HOURLY_URL = pointsResponse.properties.forecastHourly;

/** Seattle's grid timestamps as `/gridpoints/SEW/125,68/forecast{,/hourly}` sent them on 2026-10-23. */
const SEATTLE_UPDATE_TIME = '2026-10-23T07:28:59+00:00';

/**
 * The hourly feed for that grid: 156 periods shaped like the first one captured
 * (2026-10-23T00:00-07:00, 49°F, NE 3 mph), each an hour after the last.
 */
const seattleHourlyResponse = {
  properties: {
    generatedAt: '2026-10-23T07:45:06+00:00',
    updateTime: SEATTLE_UPDATE_TIME,
    periods: Array.from({ length: 156 }, (_, index) => {
      const startMs = Date.parse('2026-10-23T07:00:00Z') + index * 3_600_000;
      return {
        number: index + 1,
        name: '',
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(startMs + 3_600_000).toISOString(),
        isDaytime: false,
        temperature: 49,
        temperatureUnit: 'F',
        probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 0 },
        dewpoint: { unitCode: 'wmoUnit:degC', value: 7.222222222222222 },
        relativeHumidity: { unitCode: 'wmoUnit:percent', value: 86 },
        windSpeed: '3 mph',
        windDirection: 'NE',
        shortForecast: 'Mostly Clear',
        detailedForecast: '',
      };
    }),
  },
};

/** The same grid's 7-day feed, trimmed to its first three captured periods. */
const seattleDailyResponse = {
  properties: {
    generatedAt: '2026-10-23T07:38:44+00:00',
    updateTime: SEATTLE_UPDATE_TIME,
    periods: [
      {
        number: 1,
        name: 'Overnight',
        startTime: '2026-10-23T00:00:00-07:00',
        endTime: '2026-10-23T06:00:00-07:00',
        isDaytime: false,
        temperature: 46,
        temperatureUnit: 'F',
        probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 6 },
        windSpeed: '0 to 3 mph',
        windDirection: 'NE',
        shortForecast: 'Mostly Clear',
        detailedForecast: 'Mostly clear, with a low around 46. Northeast wind 0 to 3 mph.',
      },
      {
        number: 2,
        name: 'Friday',
        startTime: '2026-10-23T06:00:00-07:00',
        endTime: '2026-10-23T18:00:00-07:00',
        isDaytime: true,
        temperature: 56,
        temperatureUnit: 'F',
        probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 2 },
        windSpeed: '5 mph',
        windDirection: 'NW',
        shortForecast: 'Mostly Sunny',
        detailedForecast: 'Mostly sunny, with a high near 56. Northwest wind around 5 mph.',
      },
      {
        number: 3,
        name: 'Friday Night',
        startTime: '2026-10-23T18:00:00-07:00',
        endTime: '2026-10-24T06:00:00-07:00',
        isDaytime: false,
        temperature: 42,
        temperatureUnit: 'F',
        probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 2 },
        windSpeed: '3 mph',
        windDirection: 'E',
        shortForecast: 'Mostly Clear',
        detailedForecast:
          'Mostly clear. Low around 42, with temperatures rising to around 44 overnight. East wind around 3 mph.',
      },
    ],
  },
};

function geoJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/geo+json' },
  });
}

type ForecastSuccess = {
  mode: string;
  shown: number;
  totalCount: number;
  generatedAt: string;
  updateTime: string;
  periods: { startTime: string; name: string }[];
  nextCursor?: string;
  notice?: string;
};

describe('nws_get_forecast over the real NWS service', () => {
  let tool: typeof import('@/mcp-server/tools/definitions/get-forecast.tool.js')['getForecastTool'];
  let http: FetchMockHarness;

  beforeEach(async () => {
    vi.doUnmock('@/services/nws/nws-service.js');
    // Fresh module graph per test: the service's /points cache is module state.
    vi.resetModules();
    const service = await import('@/services/nws/nws-service.js');
    service.initNwsService();
    ({ getForecastTool: tool } = await import(
      '@/mcp-server/tools/definitions/get-forecast.tool.js'
    ));
    // Strict: an unrouted URL rejects, so no test can reach live NWS.
    http = createFetchMock();
    http.install();
    vi.useFakeTimers({ toFake: ['Date'] });
    // One hour after the captured updateTime.
    vi.setSystemTime(new Date('2026-10-23T08:28:59Z'));
  });

  afterEach(() => {
    http.restore();
    vi.useRealTimers();
  });

  function routeSeattle() {
    http.route(
      { match: POINTS_URL, respond: () => geoJson(pointsResponse) },
      { match: HOURLY_URL, respond: () => geoJson(seattleHourlyResponse) },
      { match: DAILY_URL, respond: () => geoJson(seattleDailyResponse) },
    );
  }

  async function call(args: Record<string, unknown>) {
    const run = await runToolContract(tool, { latitude: 47.6062, longitude: -122.3321, ...args });
    return { data: run.structuredContent as ForecastSuccess, text: contentText(run) };
  }

  const gridUrls = () => http.calls.map((c) => c.request.url).filter((url) => url !== POINTS_URL);

  it('returns the grid updateTime on every hourly page and on the 7-day forecast (issue #68)', async () => {
    routeSeattle();
    // 07:28:59Z in Seattle time; ICU joins date and time with ", " on Node, " at " on Bun.
    const updated = /\| \*\*Updated:\*\* Fri, Oct 23(?:,| at) 12:28\sAM PDT$/m;
    const pages: { data: ForecastSuccess; text: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(cursor ? { cursor } : { hourly: true });
      pages.push(page);
      cursor = page.data.nextCursor;
    } while (cursor);
    const daily = await call({});

    expect(pages).toHaveLength(4);
    for (const { data, text } of [...pages, daily]) {
      expect(data.updateTime).toBe(SEATTLE_UPDATE_TIME);
      expect(text).toMatch(updated);
      // Fresh grid (1 h old): no stale sentence on any page.
      expect(data.notice ?? '').not.toContain('last updated');
    }
    expect(pages[0]!.data.generatedAt).toBe(seattleHourlyResponse.properties.generatedAt);
    expect(daily.data.generatedAt).toBe(seattleDailyResponse.properties.generatedAt);
    expect(daily.data.mode).toBe('7-day');
  });

  describe('continuation cursor carries its mode (issue #70)', () => {
    it.each([
      ['omitted', undefined],
      ['false', false],
      ['true', true],
    ])('resumes an hourly cursor in hourly mode with hourly %s', async (_label, hourly) => {
      routeSeattle();
      const first = await call({ hourly: true });
      expect(first.data.nextCursor).toEqual(expect.any(String));

      const second = await call({
        cursor: first.data.nextCursor,
        ...(hourly === undefined ? {} : { hourly }),
      });

      expect(second.data.mode).toBe('hourly');
      expect(second.data.shown).toBe(48);
      expect(second.data.totalCount).toBe(156);
      expect(second.data.periods[0]!.startTime).toBe(
        seattleHourlyResponse.properties.periods[48]!.startTime,
      );
      expect(second.data.periods[47]!.startTime).toBe(
        seattleHourlyResponse.properties.periods[95]!.startTime,
      );
      expect(gridUrls()).toEqual([HOURLY_URL, HOURLY_URL]);
    });

    it('walks the hourly forecast to its last page with hourly omitted after the first', async () => {
      routeSeattle();
      const sizes: number[] = [];
      const starts: string[] = [];
      let cursor: string | undefined;
      let notices: (string | undefined)[] = [];
      do {
        const { data } = await call(cursor ? { cursor } : { hourly: true });
        sizes.push(data.shown);
        starts.push(...data.periods.map((p) => p.startTime));
        notices = [...notices, data.notice];
        cursor = data.nextCursor;
      } while (cursor);

      expect(sizes).toEqual([48, 48, 48, 12]);
      expect(starts).toEqual(seattleHourlyResponse.properties.periods.map((p) => p.startTime));
      expect(notices[3]).toBeUndefined();
      expect(gridUrls()).toEqual(Array(4).fill(HOURLY_URL));
    });

    it('resumes a 7-day cursor in 7-day mode under hourly: true', async () => {
      routeSeattle();

      const { data } = await call({
        hourly: true,
        cursor: encodeCursor({ offset: 1, limit: 48, hourly: false }),
      });

      expect(data.mode).toBe('7-day');
      expect(data.periods.map((p) => p.name)).toEqual(['Friday', 'Friday Night']);
      expect(gridUrls()).toEqual([DAILY_URL]);
    });

    it.each([
      ['not base64 JSON', '!!not-a-cursor!!'],
      ['a fractional offset', encodeCursor({ offset: 1.5, limit: 48 })],
      ['a fractional limit', encodeCursor({ offset: 0, limit: 2.5 })],
      ['a zero limit', encodeCursor({ offset: 0, limit: 0 })],
      ['a string mode', encodeCursor({ offset: 48, limit: 48, hourly: 'true' })],
      ['a null mode', encodeCursor({ offset: 48, limit: 48, hourly: null })],
    ])(
      'rejects a cursor that is %s as InvalidParams (invalid_cursor) with no request',
      async (_label, cursor) => {
        // Catch-all: an attempted request is recorded rather than rejected unseen.
        http.route({ match: /.*/, respond: () => geoJson({}, 404) });

        const run = await runToolContract(tool, {
          latitude: 47.6062,
          longitude: -122.3321,
          hourly: true,
          cursor,
        });

        expect(run.isError).toBe(true);
        const error = (
          run.structuredContent as {
            error: { code: number; data?: { reason?: string; recovery?: { hint?: string } } };
          }
        ).error;
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data?.reason).toBe('invalid_cursor');
        expect(error.data?.recovery?.hint).toContain('nextCursor');
        expect(http.calls).toHaveLength(0);
      },
    );
  });
});
