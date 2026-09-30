/**
 * @fileoverview Contract tests for nws_get_observation_history (issue #26). Every
 * case runs the real tool definition and the real NWS service through
 * `runToolContract` over a strict fetch fake, so station-ID validation, the
 * station-first classification, the time-window validator, the tool-owned cursor,
 * and both client surfaces are exercised with nothing below the tool mocked.
 * @module tests/tools/get-observation-history
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatTimestamp } from '@/mcp-server/tools/format-utils.js';
import { observationFeature, stationInfoResponse } from '../fixtures/nws-responses.js';

const API = 'https://api.weather.gov';
const STATION_URL = `${API}/stations/KSEA`;
const LIST_PATH = '/stations/KSEA/observations';

type HistoryTool =
  typeof import('@/mcp-server/tools/definitions/get-observation-history.tool.js')['getObservationHistoryTool'];
type Result = Awaited<ReturnType<typeof runToolContract>>;
type Observation = { timestamp: string; [key: string]: unknown };
type Success = {
  stationId: string;
  stationName: string;
  timeZone: string | null;
  observations: Observation[];
  shown: number;
  truncated?: boolean;
  cap?: number;
  nextCursor?: string;
  notice?: string;
};
type ErrorEnvelope = {
  code: number;
  data?: { reason?: string; recovery?: { hint?: string }; [key: string]: unknown };
  message: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/geo+json' },
  });
}

/** `count` observation timestamps five minutes apart, newest first, in NWS's `+00:00` form. */
function history(count: number, newest = Date.UTC(2026, 8, 30, 12, 0, 0)): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(newest - i * 5 * 60_000).toISOString().replace('.000Z', '+00:00'),
  );
}

/**
 * Serves /stations/KSEA/observations the way NWS does: newest first, `start`
 * inclusive, `end` exclusive, at most `limit` features. An unknown station would
 * also get a 200 with an empty collection, which `timestamps: []` reproduces.
 */
function observationsRoute(timestamps: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    match: (request: Request) => new URL(request.url).pathname === LIST_PATH,
    respond: (request: Request) => {
      const params = new URL(request.url).searchParams;
      const start = params.get('start');
      const end = params.get('end');
      const startMs = start ? Date.parse(start) : Number.NEGATIVE_INFINITY;
      const endMs = end ? Date.parse(end) : Number.POSITIVE_INFINITY;
      const page = timestamps
        .filter((ts) => Date.parse(ts) >= startMs && Date.parse(ts) < endMs)
        .slice(0, Number(params.get('limit')));
      return json({ features: page.map((ts) => observationFeature(ts, overrides)) });
    },
  };
}

function stationRoute(body: unknown = stationInfoResponse, status = 200) {
  return { match: STATION_URL, respond: () => json(body, status) };
}

function successOf(result: Result): { data: Success; text: string } {
  expect(result.isError).toBeFalsy();
  return {
    data: result.structuredContent as Success,
    text: result.content.map((block) => (block as { text: string }).text).join('\n'),
  };
}

function errorOf(result: Result): { error: ErrorEnvelope; text: string } {
  expect(result.isError).toBe(true);
  return {
    error: (result.structuredContent as { error: ErrorEnvelope }).error,
    text: result.content.map((block) => (block as { text: string }).text).join('\n'),
  };
}

describe('nws_get_observation_history', () => {
  let tool: HistoryTool;
  let http: FetchMockHarness;
  let origSetTimeout: typeof globalThis.setTimeout;

  /** The observation-list requests made so far, as parsed URLs. */
  const listCalls = () =>
    http.calls.map((c) => new URL(c.request.url)).filter((u) => u.pathname === LIST_PATH);

  beforeEach(async () => {
    vi.resetModules();
    const service = await import('@/services/nws/nws-service.js');
    service.initNwsService();
    ({ getObservationHistoryTool: tool } = await import(
      '@/mcp-server/tools/definitions/get-observation-history.tool.js'
    ));
    // Strict: an unrouted URL rejects, so no test can reach live NWS.
    http = createFetchMock();
    http.install();
    // Retry backoff runs immediately so an exhausted 5xx settles fast.
    origSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void) => origSetTimeout(fn, 0)) as typeof setTimeout);
  });

  afterEach(() => {
    http.restore();
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // Station ID and station-first classification
  // ---------------------------------------------------------------------------

  describe('station_id', () => {
    it('trims and uppercases the ID before requesting it', async () => {
      http.route(stationRoute(), observationsRoute(history(3)));

      const { data } = successOf(await runToolContract(tool, { station_id: '  ksea ' }));

      expect(data.stationId).toBe('KSEA');
      expect(http.calls.map((c) => new URL(c.request.url).pathname).sort()).toEqual([
        '/stations/KSEA',
        '/stations/KSEA/observations',
      ]);
    });

    it.each(['../KSEA', 'K/SEA', 'KS EA', 'KSEA%2F', '.'])(
      'fails %j as station_not_found with no request',
      async (stationId) => {
        const { error, text } = errorOf(await runToolContract(tool, { station_id: stationId }));

        expect(error.code).toBe(JsonRpcErrorCode.NotFound);
        expect(error.data?.reason).toBe('station_not_found');
        expect(text).toContain(
          `Recovery: ${tool.errors?.find((e) => e.reason === 'station_not_found')?.recovery}`,
        );
        expect(http.calls).toHaveLength(0);
      },
    );

    it('rejects a blank station_id at the schema, since the field is required', async () => {
      const { error } = errorOf(await runToolContract(tool, { station_id: '   ' }));

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(http.calls).toHaveLength(0);
    });

    it('classifies an unknown station as station_not_found even though its observation list is 200 empty', async () => {
      http.route(
        { match: `${API}/stations/KZZQ`, respond: () => json({}, 404) },
        {
          match: (request: Request) =>
            new URL(request.url).pathname === '/stations/KZZQ/observations',
          respond: () => json({ features: [] }),
        },
      );

      const { error } = errorOf(await runToolContract(tool, { station_id: 'KZZQ' }));

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('station_not_found');
      expect(error.data?.recovery?.hint).toBe(
        tool.errors?.find((e) => e.reason === 'station_not_found')?.recovery,
      );
      expect(http.calls).toHaveLength(2);
    });

    it('prefers station_not_found when the station record 404s and the list fails too', async () => {
      http.route(
        { match: STATION_URL.replace('KSEA', 'KZZQ'), respond: () => json({}, 404) },
        {
          match: (request: Request) => new URL(request.url).pathname.endsWith('/observations'),
          respond: () => json({ status: 500 }, 500),
        },
      );

      const { error } = errorOf(await runToolContract(tool, { station_id: 'KZZQ' }));

      expect(error.data?.reason).toBe('station_not_found');
    });

    it('surfaces an exhausted list outage as ServiceUnavailable with no declared reason', async () => {
      http.route(stationRoute(), {
        match: (request: Request) => new URL(request.url).pathname === LIST_PATH,
        respond: () => json({ status: 503 }, 503),
      });

      const { error } = errorOf(await runToolContract(tool, { station_id: 'KSEA' }));

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBeUndefined();
      // One first attempt plus the two retries.
      expect(listCalls()).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Time window
  // ---------------------------------------------------------------------------

  describe('invalid_time_window', () => {
    it.each([
      ['end', '2026-02-30T00:00:00Z', 'Feb 30, which Date rolls to Mar 2'],
      ['end', '2027-02-29T00:00:00Z', 'Feb 29 outside a leap year'],
      ['start', '2026-13-01T00:00:00Z', 'month 13'],
      ['start', '2026-04-31T00:00:00Z', 'Apr 31'],
      ['start', '2026-09-30T24:00:00Z', 'hour 24'],
      ['end', '2026-09-30T10:60:00Z', 'minute 60'],
      ['end', '2026-09-30T10:00:60Z', 'second 60'],
      ['start', '2026-09-30', 'a date with no time'],
      ['start', '2026-09-30T10:00Z', 'a time with no seconds'],
      ['start', '2026-09-30T10:00:00', 'no offset'],
      ['end', '2026-09-30T10:00:00+24:00', 'offset hour 24'],
      ['end', '2026-09-30T10:00:00+05:60', 'offset minute 60'],
      ['end', 'yesterday', 'free text'],
    ])('rejects %s %j (%s) with no request', async (field, value) => {
      const { error, text } = errorOf(
        await runToolContract(tool, { station_id: 'KSEA', [field]: value }),
      );
      const hint = tool.errors?.find((e) => e.reason === 'invalid_time_window')?.recovery;

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('invalid_time_window');
      expect(error.data?.recovery?.hint).toBe(hint);
      expect(error.message).toContain(`${field} "${value}"`);
      expect(text).toContain(`Recovery: ${hint}`);
      expect(http.calls).toHaveLength(0);
    });

    it.each([
      ['equal instants', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00+00:00'],
      ['start after end', '2026-09-30T11:00:00Z', '2026-09-30T10:00:00Z'],
      // 10:00-07:00 is 17:00Z, after the 12:00Z end, though its wall clock reads earlier.
      ['start after end once offsets apply', '2026-09-30T10:00:00-07:00', '2026-09-30T12:00:00Z'],
    ])('rejects %s with no request', async (_label, start, end) => {
      const { error } = errorOf(await runToolContract(tool, { station_id: 'KSEA', start, end }));

      expect(error.data?.reason).toBe('invalid_time_window');
      expect(error.message).toContain('is not before end');
      expect(http.calls).toHaveLength(0);
    });

    it.each([
      ['a leap day', '2028-02-29T00:00:00Z', '2028-03-01T00:00:00Z'],
      ['fractional seconds', '2026-09-30T10:00:00.5Z', '2026-09-30T10:00:00.500001Z'],
      [
        'an offset window whose wall clocks look inverted',
        '2026-09-30T12:00:00+05:00',
        '2026-09-30T08:00:00Z',
      ],
    ])('accepts %s and sends both values upstream verbatim', async (_label, start, end) => {
      http.route(stationRoute(), observationsRoute([]));

      successOf(await runToolContract(tool, { station_id: 'KSEA', start, end }));

      const [call] = listCalls();
      expect(call?.searchParams.get('start')).toBe(start);
      expect(call?.searchParams.get('end')).toBe(end);
    });
  });

  describe('blank optionals (issue #46)', () => {
    it.each([
      ['empty strings', ''],
      ['whitespace', '   '],
    ])('treats %s in start, end, and cursor as omitted', async (_label, blank) => {
      http.route(stationRoute(), observationsRoute(history(3)));

      const { data } = successOf(
        await runToolContract(tool, {
          station_id: 'KSEA',
          start: blank,
          end: blank,
          cursor: blank,
          limit: 2,
        }),
      );

      expect(data.observations).toHaveLength(2);
      expect(Object.fromEntries(listCalls()[0]!.searchParams)).toEqual({ limit: '2' });
    });
  });

  // ---------------------------------------------------------------------------
  // Paging
  // ---------------------------------------------------------------------------

  describe('continuation', () => {
    /** Follows nextCursor from a first call until a page omits it, returning every page. */
    async function walk(first: Record<string, unknown>): Promise<Success[]> {
      const pages: Success[] = [];
      let args: Record<string, unknown> = { station_id: 'KSEA', ...first };
      for (let guard = 0; guard < 20; guard += 1) {
        const { data } = successOf(await runToolContract(tool, args as { station_id: string }));
        pages.push(data);
        if (!data.nextCursor) return pages;
        args = { station_id: 'KSEA', cursor: data.nextCursor };
      }
      throw new Error('continuation did not terminate');
    }

    it('walks three pages with no gap or overlap and ends on a short page', async () => {
      const all = history(13);
      http.route(stationRoute(), observationsRoute(all));

      const pages = await walk({ limit: 5 });
      const seen = pages.flatMap((p) => p.observations.map((o) => o.timestamp));

      expect(pages.map((p) => p.observations.length)).toEqual([5, 5, 3]);
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(seen.length);
      expect(pages.map((p) => p.shown)).toEqual([5, 5, 3]);
      expect(pages.map((p) => p.truncated)).toEqual([true, true, undefined]);
      expect(pages.map((p) => p.cap)).toEqual([5, 5, undefined]);
      expect(pages[2]!.notice).toBeUndefined();

      // Each continuation resends the limit and moves end to the previous page's oldest.
      const ends = listCalls().map((u) => u.searchParams.get('end'));
      expect(ends).toEqual([null, all[4], all[9]]);
      expect(listCalls().every((u) => u.searchParams.get('limit') === '5')).toBe(true);
    });

    it('follows a full final page with an empty continuation that says the history ended', async () => {
      const all = history(10);
      http.route(stationRoute(), observationsRoute(all));

      const pages = await walk({ limit: 5 });

      expect(pages.map((p) => p.observations.length)).toEqual([5, 5, 0]);
      expect(pages.flatMap((p) => p.observations.map((o) => o.timestamp))).toEqual(all);
      const last = pages[2]!;
      expect(last.nextCursor).toBeUndefined();
      expect(last.truncated).toBeUndefined();
      expect(last.notice).toContain(`No observations remain before ${all[9]}`);
      expect(last.notice).toContain('7 days');
    });

    it('carries the first call’s start and limit in the cursor, over any inputs sent with it', async () => {
      const all = history(20);
      const start = all[11]!;
      http.route(stationRoute(), observationsRoute(all));

      const first = successOf(await runToolContract(tool, { station_id: 'KSEA', start, limit: 4 }));
      const second = successOf(
        await runToolContract(tool, {
          station_id: 'KSEA',
          cursor: first.data.nextCursor!,
          // A cursor carries its own window; these apply to the first page only.
          start: '2026-09-01T00:00:00Z',
          end: '2026-02-30T00:00:00Z',
          limit: 50,
        }),
      );

      expect(second.data.observations.map((o) => o.timestamp)).toEqual(all.slice(4, 8));
      const [, call] = listCalls();
      expect(Object.fromEntries(call!.searchParams)).toEqual({ limit: '4', start, end: all[3] });
    });

    it('stops at a full page whose oldest observation sits on start, with no empty follow-up', async () => {
      const all = history(20);
      http.route(stationRoute(), observationsRoute(all));

      // start = all[11] is inclusive, so the window holds exactly 12 observations.
      const pages = await walk({ start: all[11], limit: 4 });

      expect(pages.map((p) => p.observations.length)).toEqual([4, 4, 4]);
      expect(pages.flatMap((p) => p.observations.map((o) => o.timestamp))).toEqual(
        all.slice(0, 12),
      );
      expect(pages[2]!.nextCursor).toBeUndefined();
      expect(pages[2]!.truncated).toBeUndefined();
      expect(listCalls()).toHaveLength(3);
    });

    it('returns a short first page with no cursor and no notice', async () => {
      http.route(stationRoute(), observationsRoute(history(3)));

      const { data } = successOf(await runToolContract(tool, { station_id: 'KSEA', limit: 5 }));

      expect(data.shown).toBe(3);
      expect(data.nextCursor).toBeUndefined();
      expect(data.truncated).toBeUndefined();
      expect(data.notice).toBeUndefined();
    });

    it('discloses a full page on both surfaces', async () => {
      const all = history(8);
      http.route(stationRoute(), observationsRoute(all));

      const { data, text } = successOf(
        await runToolContract(tool, { station_id: 'KSEA', limit: 5 }),
      );

      expect(data).toMatchObject({ shown: 5, truncated: true, cap: 5 });
      expect(data.nextCursor).toEqual(expect.any(String));
      expect(data.notice).toContain(`continue from before ${all[4]}`);
      expect(text).toContain(`**Next Cursor:** ${data.nextCursor}`);
      expect(text).toContain('**Returned:** 5');
      expect(text).toContain(`continue from before ${all[4]}`);
    });

    it.each([
      ['not base64 JSON', '!!not-a-cursor!!'],
      ['a paging cursor with no end', encodeCursor({ offset: 0, limit: 5 })],
      [
        'a calendar-invalid end',
        encodeCursor({ offset: 0, limit: 5, end: '2026-02-30T00:00:00+00:00' }),
      ],
      [
        'a start not before end',
        encodeCursor({
          offset: 0,
          limit: 5,
          start: '2026-09-30T12:00:00Z',
          end: '2026-09-30T11:00:00+00:00',
        }),
      ],
      [
        'a limit past the cap',
        encodeCursor({ offset: 0, limit: 500, end: '2026-09-30T11:00:00Z' }),
      ],
      ['a fractional limit', encodeCursor({ offset: 0, limit: 2.5, end: '2026-09-30T11:00:00Z' })],
    ])(
      'rejects a cursor that is %s as InvalidParams (invalid_cursor) with no request',
      async (_label, cursor) => {
        const { error } = errorOf(await runToolContract(tool, { station_id: 'KSEA', cursor }));

        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data?.reason).toBe('invalid_cursor');
        expect(error.data?.recovery?.hint).toContain('nextCursor');
        expect(http.calls).toHaveLength(0);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Empty windows
  // ---------------------------------------------------------------------------

  describe('empty results', () => {
    it('answers an empty window with success, an empty list, and the retention notice', async () => {
      http.route(stationRoute(), observationsRoute(history(5)));

      const { data, text } = successOf(
        await runToolContract(tool, {
          station_id: 'KSEA',
          start: '2026-09-01T00:00:00Z',
          end: '2026-09-02T00:00:00Z',
        }),
      );

      expect(data.observations).toEqual([]);
      expect(data.shown).toBe(0);
      expect(data.nextCursor).toBeUndefined();
      expect(data.notice).toContain('between 2026-09-01T00:00:00Z and 2026-09-02T00:00:00Z');
      expect(data.notice).toContain('last 7 days');
      expect(text).toContain('No observations in this window.');
      expect(text).toContain('last 7 days');
    });

    it('routes a station with no history at all to nws_find_stations', async () => {
      http.route(stationRoute(), observationsRoute([]));

      const { data } = successOf(await runToolContract(tool, { station_id: 'KSEA' }));

      expect(data.notice).toContain('nws_find_stations');
    });
  });

  // ---------------------------------------------------------------------------
  // Output shape on both surfaces
  // ---------------------------------------------------------------------------

  describe('output', () => {
    it('rounds each measurement like nws_get_observations and renders one dual-unit row per observation', async () => {
      const [newest, older] = history(2);
      http.route(stationRoute(), {
        match: (request: Request) => new URL(request.url).pathname === LIST_PATH,
        respond: () =>
          json({
            features: [
              observationFeature(newest!, {
                temperature: { value: 14.44, unitCode: 'wmoUnit:degC' },
                windGust: { value: 40.7, unitCode: 'wmoUnit:km_h-1' },
                relativeHumidity: { value: 65.2791, unitCode: 'wmoUnit:percent' },
                barometricPressure: { value: 101693.25, unitCode: 'wmoUnit:Pa' },
              }),
              observationFeature(older!),
            ],
          }),
      });

      const { data, text } = successOf(await runToolContract(tool, { station_id: 'KSEA' }));
      const [first] = data.observations;

      expect(first).toMatchObject({
        timestamp: newest,
        textDescription: 'Mostly Cloudy',
        temperatureC: 14,
        windSpeedKmh: 19,
        windDirectionDeg: 200,
        windGustKmh: 41,
        relativeHumidityPct: 65,
        barometricPressurePa: 101693,
        visibilityM: 16093,
        cloudLayers: [{ amount: 'BKN', baseM: 1524 }],
      });

      const rows = text.split('\n').filter((line) => /^\| [A-Z][a-z]{2}, /.test(line));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toBe(
        `| ${formatTimestamp(newest!, 'America/Los_Angeles')} | Mostly Cloudy | 57°F (14°C) | 46°F (8°C) | 65% | 200° 12 mph (19 km/h), gusts 25 mph (41 km/h) | 30.03 inHg (1017 hPa, 101693 Pa) | 10 mi (16.1 km, 16093 m) | — | — | BKN at 1524m (5000 ft) |`,
      );
      expect(text).toContain(
        '## Observation History — Seattle, Seattle-Tacoma International Airport (KSEA)',
      );
      expect(text).toContain('**Station time zone:** America/Los_Angeles');
      expect(text).toContain('2 observations, newest first.');
    });

    it('keeps a sparse observation null on structuredContent and — in the table, never 0', async () => {
      const [ts] = history(1);
      http.route(stationRoute(), {
        match: (request: Request) => new URL(request.url).pathname === LIST_PATH,
        respond: () =>
          json({
            features: [
              {
                properties: {
                  timestamp: ts,
                  // Every measurement omitted, as on a METAR gap.
                },
              },
            ],
          }),
      });

      const { data, text } = successOf(await runToolContract(tool, { station_id: 'KSEA' }));

      expect(data.observations[0]).toEqual({
        timestamp: ts,
        textDescription: '',
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
      });
      expect(text).toContain(
        `| ${formatTimestamp(ts!, 'America/Los_Angeles')} | — | — | — | — | — | — | — | — | — | — |`,
      );
    });

    it('renders offset times and "Not available" when the station record has no time zone', async () => {
      const [ts] = history(1);
      http.route(
        stationRoute({ properties: { name: 'No Zone Station' } }),
        observationsRoute([ts!]),
      );

      const { data, text } = successOf(await runToolContract(tool, { station_id: 'KSEA' }));

      expect(data.timeZone).toBeNull();
      expect(data.stationName).toBe('No Zone Station');
      expect(text).toContain('**Station time zone:** Not available');
      // No zone to convert into, so the time renders at its own offset.
      expect(formatTimestamp(ts!, null)).toMatch(/12:00 PM UTC\+00:00$/);
      expect(text).toContain(`| ${formatTimestamp(ts!, null)} |`);
    });
  });
});
