/**
 * @fileoverview Native amount parsing, retry deadlines, and forecast contract integration.
 * @module tests/services/nws/forecast-amounts
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forecastResponse, pointsResponse } from '../../fixtures/nws-responses.js';

const gridUrl = 'https://api.weather.gov/gridpoints/SEW/125,68';
const intervals = [
  { validTime: '2026-04-03T00:00:00Z/2026-04-04T00:00:00Z', value: 1.25 },
  { validTime: '2026-04-03T00:00:00Z/P1D', value: 0 },
  { validTime: 'P1M/NOW', value: null },
];
const grid = {
  properties: {
    updateTime: '2026-04-03T11:00:00Z',
    quantitativePrecipitation: { uom: 'wmoUnit:mm', values: intervals },
    snowfallAmount: { values: [] },
    iceAccumulation: { uom: 'native:ice', values: [{ validTime: 'NOW/PT3H', value: null }] },
  },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('forecast amounts through the real service and tool', () => {
  let service: typeof import('@/services/nws/nws-service.js');
  let tool: typeof import('@/mcp-server/tools/definitions/get-forecast.tool.js')['getForecastTool'];
  let gridFetch: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
  let fetchFake: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

  beforeEach(async () => {
    vi.resetModules();
    service = await import('@/services/nws/nws-service.js');
    service.initNwsService();
    tool = (await import('@/mcp-server/tools/definitions/get-forecast.tool.js')).getForecastTool;
    gridFetch = vi.fn(async () => json(grid));
    fetchFake = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/points/'))
        return json({ properties: { ...pointsResponse.properties, forecastGridData: gridUrl } });
      if (url === gridUrl) return gridFetch(url, init);
      if (
        url === pointsResponse.properties.forecast ||
        url === pointsResponse.properties.forecastHourly
      )
        return json(forecastResponse);
      throw new Error(`Unexpected route: ${url}`);
    });
    vi.stubGlobal('fetch', fetchFake);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('leaves ordinary forecast periods and request count unchanged without opt-in', async () => {
    const result = await service
      .getNwsService()
      .getForecast(47.6, -122.3, false, createMockContext());
    expect(result.forecast.periods.map((p) => [p.name, p.temperature])).toEqual([
      ['Today', 62],
      ['Tonight', 45],
    ]);
    expect(result).not.toHaveProperty('precipitationAmounts');
    expect(result).not.toHaveProperty('amountsUpdateTime');
    expect(fetchFake).toHaveBeenCalledTimes(2);
    expect(gridFetch).not.toHaveBeenCalled();
  });

  it('preserves every interval, layer, unit and null on both contract surfaces', async () => {
    const result = await runToolContract(tool, {
      latitude: 47.6,
      longitude: -122.3,
      include_amounts: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      amountsUpdateTime: '2026-04-03T11:00:00Z',
      precipitationAmounts: [
        { layer: 'quantitativePrecipitation', uom: 'wmoUnit:mm', values: intervals },
        { layer: 'snowfallAmount', uom: null, values: [] },
        {
          layer: 'iceAccumulation',
          uom: 'native:ice',
          values: [{ validTime: 'NOW/PT3H', value: null }],
        },
      ],
    });
    const text = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
    for (const interval of intervals)
      expect(text).toContain(`${interval.validTime}: ${interval.value}`);
    expect(text).toContain('2026-04-03T11:00:00Z');
    expect(text).toContain('Intervals: []');
    expect(text).toContain('native:ice');
    expect(fetchFake).toHaveBeenCalledTimes(3);
  });

  it('distinguishes missing layers and metadata from present empty layers', async () => {
    gridFetch.mockImplementation(async () =>
      json({ properties: { snowfallAmount: { values: [] } } }),
    );
    const result = await runToolContract(tool, {
      latitude: 47.6,
      longitude: -122.3,
      include_amounts: true,
    });
    expect(result.structuredContent).toMatchObject({
      amountsUpdateTime: null,
      precipitationAmounts: [{ layer: 'snowfallAmount', uom: null, values: [] }],
      notice: expect.stringContaining('quantitativePrecipitation, iceAccumulation'),
    });
    expect(result.content.map((b) => ('text' in b ? b.text : '')).join('\n')).toContain(
      'quantitativePrecipitation, iceAccumulation',
    );
  });

  it('retains an empty amount collection and names every missing layer', async () => {
    gridFetch.mockResolvedValueOnce(json({ properties: {} }));
    const result = await runToolContract(tool, {
      latitude: 47.6,
      longitude: -122.3,
      include_amounts: true,
    });
    expect(result.structuredContent).toMatchObject({
      amountsUpdateTime: null,
      precipitationAmounts: [],
      notice: expect.stringContaining('quantitativePrecipitation, snowfallAmount, iceAccumulation'),
    });
    expect(result.content.map((b) => ('text' in b ? b.text : '')).join('\n')).toContain(
      'Layers: []',
    );
  });

  it('does not invent a grid URL when points omit forecastGridData', async () => {
    fetchFake.mockImplementation(async (url) =>
      url.includes('/points/') ? json(pointsResponse) : json(forecastResponse),
    );
    const result = await runToolContract(tool, {
      latitude: 47.6,
      longitude: -122.3,
      include_amounts: true,
    });
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('no forecastGridData URL'),
    });
    expect(result.structuredContent).not.toHaveProperty('precipitationAmounts');
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled grid body read with the same optional deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('deadline', 'TimeoutError')), ms);
      return c.signal;
    });
    gridFetch.mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init!.signal!.addEventListener(
                'abort',
                () => controller.error(init!.signal!.reason),
                { once: true },
              );
            },
          }),
        ),
    );
    let settled = false;
    const pending = service
      .getNwsService()
      .getForecast(47.6, -122.3, false, createMockContext(), true)
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).amountsNotice).toContain('amounts unavailable');
    expect(gridFetch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'keeps opt-in per call on a cursor past the end (hourly: %s)',
    async (hourly) => {
      const args = {
        latitude: 47.6,
        longitude: -122.3,
        cursor: encodeCursor({ offset: 48, limit: 48, hourly }),
      };
      const first = await runToolContract(tool, { ...args, include_amounts: true });
      expect(first.structuredContent).toMatchObject({
        shown: 0,
        mode: hourly ? 'hourly' : '7-day',
        precipitationAmounts: expect.any(Array),
        notice: expect.stringContaining('past the end'),
      });
      expect(first.content.map((b) => ('text' in b ? b.text : '')).join('\n')).toContain('P1M/NOW');
      const second = await runToolContract(tool, args);
      expect(second.structuredContent).not.toHaveProperty('precipitationAmounts');
      expect(gridFetch).toHaveBeenCalledTimes(1);
      expect(fetchFake.mock.calls.filter(([url]) => String(url).includes('/points/'))).toHaveLength(
        1,
      );
    },
  );

  it('composes missing amounts, stale data, and paging notices while keeping cursor-owned mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T12:00:00Z'));
    gridFetch.mockImplementation(async () => json({ properties: {} }));
    const longForecast = {
      properties: {
        ...forecastResponse.properties,
        periods: Array.from({ length: 100 }, (_, index) => ({
          ...forecastResponse.properties.periods[0]!,
          name: `Period ${index}`,
          number: index + 1,
        })),
      },
    };
    fetchFake.mockImplementation(async (url, init) => {
      if (url.includes('/points/'))
        return json({ properties: { ...pointsResponse.properties, forecastGridData: gridUrl } });
      if (url === gridUrl) return gridFetch(url, init);
      return json(longForecast);
    });
    const first = await runToolContract(tool, {
      latitude: 47.6,
      longitude: -122.3,
      hourly: true,
      include_amounts: true,
    });
    const firstData = first.structuredContent as { nextCursor: string; notice: string };
    expect(firstData.notice).toContain('48h ago');
    expect(firstData.notice).toContain('first 48 of 100');
    expect(firstData.notice).toContain(
      'quantitativePrecipitation, snowfallAmount, iceAccumulation',
    );
    const second = await runToolContract(tool, {
      latitude: 47.6,
      longitude: -122.3,
      cursor: firstData.nextCursor,
      hourly: false,
    });
    expect(second.structuredContent).toMatchObject({
      mode: 'hourly',
      shown: 48,
      periods: expect.arrayContaining([expect.objectContaining({ name: 'Period 48' })]),
    });
    expect(second.structuredContent).not.toHaveProperty('precipitationAmounts');
    const last = await runToolContract(tool, {
      latitude: 47.6,
      longitude: -122.3,
      cursor: (second.structuredContent as { nextCursor: string }).nextCursor,
      include_amounts: true,
    });
    expect(last.structuredContent).toMatchObject({
      shown: 4,
      periods: expect.arrayContaining([expect.objectContaining({ name: 'Period 99' })]),
      precipitationAmounts: [],
    });
    expect(last.structuredContent).not.toHaveProperty('nextCursor');
    expect(gridFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid amount input before any request', async () => {
    const args: { latitude: number; longitude: number } & Record<string, unknown> = {
      latitude: 47.6,
      longitude: -122.3,
      include_amounts: {},
    };
    const result = await runToolContract(tool, args);
    expect(result.isError).toBe(true);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it.each([404, 503, 'invalid-json', 'invalid-shape'] as const)(
    'retains forecast for classified amount unavailability: %s',
    async (failure) => {
      vi.useFakeTimers();
      gridFetch.mockImplementation(async () =>
        failure === 'invalid-json'
          ? new Response('broken')
          : failure === 'invalid-shape'
            ? json({ properties: { quantitativePrecipitation: { values: [{ value: 1 }] } } })
            : json({}, failure),
      );
      const pending = runToolContract(tool, {
        latitude: 47.6,
        longitude: -122.3,
        include_amounts: true,
      });
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        periods: expect.arrayContaining([expect.objectContaining({ temperature: 62 })]),
        notice: expect.stringContaining('amounts unavailable'),
      });
      expect(result.structuredContent).not.toHaveProperty('precipitationAmounts');
      expect(result.structuredContent).not.toHaveProperty('amountsUpdateTime');
      expect(gridFetch).toHaveBeenCalledTimes(failure === 503 ? 3 : 1);
    },
  );

  it('retries a transient amount failure and parses the succeeding response', async () => {
    vi.useFakeTimers();
    gridFetch.mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(grid));
    const pending = runToolContract(tool, {
      latitude: 47.6,
      longitude: -122.3,
      include_amounts: true,
    });
    await vi.runAllTimersAsync();
    expect((await pending).structuredContent).toMatchObject({
      amountsUpdateTime: '2026-04-03T11:00:00Z',
    });
    expect(gridFetch).toHaveBeenCalledTimes(2);
  });

  it.each(['caller', 'programmer', 'input'])(
    'propagates %s failures instead of degrading',
    async (failure) => {
      const controller = new AbortController();
      gridFetch.mockImplementation(async () => {
        if (failure === 'caller') {
          controller.abort();
          throw controller.signal.reason;
        }
        if (failure === 'input') return json({ detail: 'Invalid grid request' }, 400);
        throw new Error('programmer failure');
      });
      const pending = service
        .getNwsService()
        .getForecast(47.6, -122.3, false, createMockContext({ signal: controller.signal }), true);
      if (failure === 'programmer') await expect(pending).rejects.toThrow('programmer failure');
      else
        await expect(pending).rejects.toMatchObject({
          code:
            failure === 'caller'
              ? JsonRpcErrorCode.RequestCancelled
              : JsonRpcErrorCode.ValidationError,
        });
      expect(gridFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds a hung optional feed including retry backoff to eight seconds', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('deadline', 'TimeoutError')), ms);
      return c.signal;
    });
    gridFetch.mockResolvedValueOnce(json({}, 503)).mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );
    let settled = false;
    const pending = service
      .getNwsService()
      .getForecast(47.6, -122.3, false, createMockContext(), true)
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(7999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.forecast.periods).toHaveLength(2);
    expect(result.amountsNotice).toContain('amounts unavailable');
    expect(gridFetch).toHaveBeenCalledTimes(2);
  });

  it.each(['optional', 'mandatory', 'caller'] as const)(
    'bounds the complete opted-in operation and distinguishes %s termination',
    async (termination) => {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const c = new AbortController();
        setTimeout(() => c.abort(new DOMException('deadline', 'TimeoutError')), ms);
        return c.signal;
      });
      const caller = new AbortController();
      let pointAttempts = 0;
      let forecastAttempts = 0;
      fetchFake.mockImplementation(async (url, init) => {
        const signal = init!.signal!;
        if (url.includes('/points/')) {
          if (++pointAttempts <= 2)
            return new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            );
          await new Promise((resolve) => setTimeout(resolve, 9000));
          return json({ properties: { ...pointsResponse.properties, forecastGridData: gridUrl } });
        }
        if (url === pointsResponse.properties.forecast) {
          if (++forecastAttempts === 1)
            return new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            );
          if (termination === 'mandatory')
            return new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            );
          await new Promise((resolve) => setTimeout(resolve, 6000));
          return json(forecastResponse);
        }
        if (url === gridUrl)
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        throw new Error('unexpected route');
      });
      let settled = false;
      const pending = service
        .getNwsService()
        .getForecast(47.6, -122.3, false, createMockContext({ signal: caller.signal }), true)
        .then(
          (value) => {
            settled = true;
            return { value };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
      await vi.advanceTimersByTimeAsync(54000);
      expect(settled).toBe(false);
      if (termination === 'caller') caller.abort();
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(settled).toBe(true);
      if (termination === 'optional') {
        expect(result).toMatchObject({
          value: {
            forecast: { periods: expect.any(Array) },
            amountsNotice: expect.stringContaining('amounts unavailable'),
          },
        });
      } else
        expect(result).toMatchObject({
          error: {
            code:
              termination === 'caller'
                ? JsonRpcErrorCode.RequestCancelled
                : JsonRpcErrorCode.Timeout,
          },
        });
    },
  );
});
