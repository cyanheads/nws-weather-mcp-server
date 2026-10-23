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
  requestedLimit?: number;
  effectiveLimit?: number;
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
      [
        'start',
        '2026-09-30T10:00:00.1234567Z',
        'seven fractional-second digits, past the six NWS takes',
      ],
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
      // One past the page size, so the extra record says whether older ones remain.
      expect(Object.fromEntries(listCalls()[0]!.searchParams)).toEqual({ limit: '3' });
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

      // Each request asks for one past the page size and moves end to the previous page's oldest.
      const ends = listCalls().map((u) => u.searchParams.get('end'));
      expect(ends).toEqual([null, all[4], all[9]]);
      expect(listCalls().map((u) => u.searchParams.get('limit'))).toEqual(['6', '6', '6']);
    });

    it('ends on a full final page in two list requests, with no empty third page', async () => {
      const all = history(10);
      http.route(stationRoute(), observationsRoute(all));

      const pages = await walk({ limit: 5 });

      expect(pages.map((p) => p.observations.length)).toEqual([5, 5]);
      expect(pages.flatMap((p) => p.observations.map((o) => o.timestamp))).toEqual(all);
      const last = pages[1]!;
      expect(last.nextCursor).toBeUndefined();
      expect(last.truncated).toBeUndefined();
      expect(last.cap).toBeUndefined();
      expect(last.notice).toBeUndefined();
      expect(listCalls()).toHaveLength(2);
    });

    it('returns a window holding exactly limit observations with no cursor, no truncation, and no notice', async () => {
      const all = history(5);
      http.route(stationRoute(), observationsRoute(all));

      const { data, text } = successOf(
        await runToolContract(tool, { station_id: 'KSEA', limit: 5 }),
      );

      expect(data.observations.map((o) => o.timestamp)).toEqual(all);
      expect(data.shown).toBe(5);
      expect(data).not.toHaveProperty('truncated');
      expect(data).not.toHaveProperty('cap');
      expect(data).not.toHaveProperty('nextCursor');
      expect(data).not.toHaveProperty('notice');
      expect(text).not.toContain('Next Cursor');
      expect(text).not.toContain('Page Full');
      expect(listCalls()).toHaveLength(1);
      expect(listCalls()[0]!.searchParams.get('limit')).toBe('6');
    });

    it('holds a limit + 1 window to limit, discloses it on both surfaces, and continues to the last one', async () => {
      const all = history(6);
      http.route(stationRoute(), observationsRoute(all));

      const first = successOf(await runToolContract(tool, { station_id: 'KSEA', limit: 5 }));

      const guidance = `Returned 5 observations, the page limit; older observations remain in this window. Pass nextCursor back as cursor to continue from before ${all[4]}.`;
      expect(first.data.observations.map((o) => o.timestamp)).toEqual(all.slice(0, 5));
      expect(first.data).toMatchObject({ shown: 5, truncated: true, cap: 5 });
      expect(first.data.nextCursor).toEqual(expect.any(String));
      expect(first.data.notice).toBe(guidance);
      expect(first.text).toContain(`**Next Cursor:** ${first.data.nextCursor}`);
      expect(first.text).toContain('**Page Full:** true');
      expect(first.text).toContain('**Page Limit:** 5');
      expect(first.text).toContain(guidance);

      const second = successOf(
        await runToolContract(tool, { station_id: 'KSEA', cursor: first.data.nextCursor! }),
      );

      expect(second.data.observations.map((o) => o.timestamp)).toEqual([all[5]]);
      expect(second.data).not.toHaveProperty('nextCursor');
      expect(second.data).not.toHaveProperty('truncated');
      expect(second.data).not.toHaveProperty('notice');
      const [, call] = listCalls();
      expect(Object.fromEntries(call!.searchParams)).toEqual({ limit: '6', end: all[4] });
    });

    it('keeps the empty-continuation notice when the remaining observations aged out', async () => {
      const all = history(4);
      http.route(stationRoute(), observationsRoute(all));
      // A cursor minted when older observations still existed, before NWS dropped them.
      const cursor = encodeCursor({ offset: 0, limit: 5, end: all[3] });

      const { data, text } = successOf(await runToolContract(tool, { station_id: 'KSEA', cursor }));

      const notice = `No observations remain before ${all[3]} — that is the end of KSEA's history in this window. NWS keeps about the last 7 days of a station's observations.`;
      expect(data.observations).toEqual([]);
      expect(data).not.toHaveProperty('nextCursor');
      expect(data.notice).toBe(notice);
      expect(text).toContain(notice);
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
      // The cursor's own page size, not the limit sent beside it, and no clamp disclosure.
      expect(second.data).not.toHaveProperty('requestedLimit');
      expect(second.data).not.toHaveProperty('effectiveLimit');
      const [, call] = listCalls();
      expect(Object.fromEntries(call!.searchParams)).toEqual({ limit: '5', start, end: all[3] });
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

    it('discloses a truncated page on both surfaces, with no clamp for a limit within the cap', async () => {
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
      // A limit within the cap discloses no clamp: the notice is the continuation alone.
      expect(data).not.toHaveProperty('requestedLimit');
      expect(data).not.toHaveProperty('effectiveLimit');
      expect(data.notice).toBe(
        `Returned 5 observations, the page limit; older observations remain in this window. Pass nextCursor back as cursor to continue from before ${all[4]}.`,
      );
      expect(text).not.toContain('**Requested Limit:**');
      expect(text).not.toContain('**Applied Limit:**');
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
      ['a zero limit', encodeCursor({ offset: 0, limit: 0, end: '2026-09-30T11:00:00Z' })],
      ['a negative limit', encodeCursor({ offset: 0, limit: -3, end: '2026-09-30T11:00:00Z' })],
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
  // Oversized limit (issue #53)
  // ---------------------------------------------------------------------------

  describe('limit past the 100-observation cap', () => {
    const CLAMP = 'Requested limit 101 exceeds the per-page cap of 100; this page holds up to 100.';

    it('serves 100, discloses the clamp ahead of the truncation notice on both surfaces, and continues 100 per page', async () => {
      const all = history(250);
      http.route(stationRoute(), observationsRoute(all));

      const first = successOf(await runToolContract(tool, { station_id: 'KSEA', limit: 101 }));

      expect(first.data.observations).toHaveLength(100);
      expect(first.data).toMatchObject({
        shown: 100,
        truncated: true,
        cap: 100,
        requestedLimit: 101,
        effectiveLimit: 100,
      });
      const notice = `${CLAMP} Returned 100 observations, the page limit; older observations remain in this window. Pass nextCursor back as cursor to continue from before ${all[99]}.`;
      expect(first.data.notice).toBe(notice);
      expect(first.text).toContain(notice);
      expect(first.text).toContain('**Requested Limit:** 101');
      expect(first.text).toContain('**Applied Limit:** 100');

      const second = successOf(
        await runToolContract(tool, { station_id: 'KSEA', cursor: first.data.nextCursor! }),
      );
      const third = successOf(
        await runToolContract(tool, { station_id: 'KSEA', cursor: second.data.nextCursor! }),
      );

      expect(second.data.observations.map((o) => o.timestamp)).toEqual(all.slice(100, 200));
      expect(third.data.observations.map((o) => o.timestamp)).toEqual(all.slice(200));
      expect(third.data).not.toHaveProperty('nextCursor');
      // Continued pages keep the applied 100 and disclose no clamp.
      expect(second.data.notice).toBe(
        `Returned 100 observations, the page limit; older observations remain in this window. Pass nextCursor back as cursor to continue from before ${all[199]}.`,
      );
      expect(third.data).not.toHaveProperty('notice');
      for (const page of [second, third]) {
        expect(page.data).not.toHaveProperty('requestedLimit');
        expect(page.data).not.toHaveProperty('effectiveLimit');
        expect(page.text).not.toContain('per-page cap');
      }
      expect(listCalls().map((u) => u.searchParams.get('limit'))).toEqual(['101', '101', '101']);
    });

    it('discloses the clamp alone when the window fits one page', async () => {
      const all = history(30);
      http.route(stationRoute(), observationsRoute(all));

      const { data, text } = successOf(
        await runToolContract(tool, { station_id: 'KSEA', limit: 10_000 }),
      );

      expect(data.observations).toHaveLength(30);
      expect(data).not.toHaveProperty('nextCursor');
      expect(data).not.toHaveProperty('truncated');
      expect(data).toMatchObject({ requestedLimit: 10_000, effectiveLimit: 100 });
      expect(data.notice).toBe(
        'Requested limit 10000 exceeds the per-page cap of 100; this page holds up to 100.',
      );
      expect(text).toContain('**Applied Limit:** 100');
      expect(listCalls()[0]!.searchParams.get('limit')).toBe('101');
    });

    it('composes the clamp with the empty-window notice', async () => {
      http.route(stationRoute(), observationsRoute(history(5)));

      const { data } = successOf(
        await runToolContract(tool, {
          station_id: 'KSEA',
          start: '2026-09-01T00:00:00Z',
          end: '2026-09-02T00:00:00Z',
          limit: 101,
        }),
      );

      expect(data.notice).toBe(
        `${CLAMP} No observations from KSEA between 2026-09-01T00:00:00Z and 2026-09-02T00:00:00Z. NWS keeps about the last 7 days of a station's observations, so move the window inside that range, or omit start and end for the latest.`,
      );
    });

    it('serves a limit of exactly 100 with no clamp disclosure', async () => {
      http.route(stationRoute(), observationsRoute(history(30)));

      const { data } = successOf(await runToolContract(tool, { station_id: 'KSEA', limit: 100 }));

      expect(data.observations).toHaveLength(30);
      expect(data).not.toHaveProperty('requestedLimit');
      expect(data).not.toHaveProperty('effectiveLimit');
      expect(data).not.toHaveProperty('notice');
      expect(listCalls()[0]!.searchParams.get('limit')).toBe('101');
    });

    it.each([
      ['past the 10000 ceiling', 10_001],
      ['zero', 0],
      ['fractional', 2.5],
    ])('rejects a limit %s as invalid_arguments with no request', async (_label, limit) => {
      const { error } = errorOf(await runToolContract(tool, { station_id: 'KSEA', limit }));

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(http.calls).toHaveLength(0);
    });
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
        temperatureC: 14.4,
        dewpointC: 8.3,
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
        `| ${formatTimestamp(newest!, 'America/Los_Angeles')} | Mostly Cloudy | 58°F (14.4°C) | 47°F (8.3°C) | 65% | 200° 12 mph (19 km/h), gusts 25 mph (41 km/h) | 30.03 inHg (1017 hPa, 101693 Pa) | 10 mi (16.1 km, 16093 m) | — | — | — | BKN at 1524m (5000 ft) |`,
      );
      expect(text).toContain(
        '## Observation History — Seattle, Seattle-Tacoma International Airport (KSEA)',
      );
      expect(text).toContain('**Station time zone:** America/Los_Angeles');
      expect(text).toContain('2 observations, newest first.');
    });

    it('keeps temperatures at one decimal, whole degrees without .0, and °F from the shown °C (issue #64)', async () => {
      // Newest: KPDX 2026-10-23T06:53Z (raw `08/03 … T00830033`, NWS wind chill float).
      // Older: KDEN 2026-10-23T04:25Z, a 5-minute record at whole degrees.
      // Oldest: a negative tenth with an NWS-computed heat index float.
      const [metar, fiveMinute, negative] = history(3);
      const degC = (value: number | null) => ({ value, unitCode: 'wmoUnit:degC' });
      http.route(stationRoute(), {
        match: (request: Request) => new URL(request.url).pathname === LIST_PATH,
        respond: () =>
          json({
            features: [
              observationFeature(metar!, {
                temperature: degC(8.3),
                dewpoint: degC(3.3),
                windChill: degC(7.710126527509445),
              }),
              observationFeature(fiveMinute!, { temperature: degC(17), dewpoint: degC(7) }),
              observationFeature(negative!, {
                temperature: degC(-0.4),
                dewpoint: degC(-6.1),
                heatIndex: degC(24.151),
              }),
            ],
          }),
      });

      const { data, text } = successOf(await runToolContract(tool, { station_id: 'KSEA' }));

      expect(
        data.observations.map((o) => [o.temperatureC, o.dewpointC, o.heatIndexC, o.windChillC]),
      ).toEqual([
        [8.3, 3.3, null, 7.7],
        [17, 7, null, null],
        [-0.4, -6.1, 24.2, null],
      ]);
      const rows = text.split('\n').filter((line) => /^\| [A-Z][a-z]{2}, /.test(line));
      // Temperature, Dewpoint, Heat Index, Wind Chill cells.
      const temps = (row: string) => row.split(' | ').filter((_, i) => [2, 3, 8, 9].includes(i));
      expect(rows.map(temps)).toEqual([
        ['47°F (8.3°C)', '38°F (3.3°C)', '—', '46°F (7.7°C)'],
        ['63°F (17°C)', '45°F (7°C)', '—', '—'],
        ['31°F (-0.4°C)', '21°F (-6.1°C)', '76°F (24.2°C)', '—'],
      ]);
    });

    it('returns 1-, 3-, and 6-hour precipitation in mm, 0 as a trace, and — when none was reported (issue #65)', async () => {
      // Newest: KSLC 2026-10-23T02:54Z (`P0013 60024`). Next: KCOS 2026-10-23T02:54Z
      // (`P0000 60000`, two traces). Next: a dry hourly METAR (the base fixture, all
      // three null). Oldest: a 5-minute record (KDEN 2026-10-23T04:25Z) with the 1- and
      // 6-hour keys absent.
      const [rain, trace, dry, fiveMinute] = history(4);
      const mm = (value: number | null) => ({
        unitCode: 'wmoUnit:mm',
        value,
        qualityControl: value == null ? 'Z' : 'C',
      });
      const {
        precipitationLastHour: _1h,
        precipitationLast6Hours: _6h,
        ...fiveMinuteProperties
      } = observationFeature(fiveMinute!).properties;
      http.route(stationRoute(), {
        match: (request: Request) => new URL(request.url).pathname === LIST_PATH,
        respond: () =>
          json({
            features: [
              observationFeature(rain!, {
                precipitationLastHour: mm(3.3),
                precipitationLast3Hours: mm(6.1),
                precipitationLast6Hours: mm(null),
              }),
              observationFeature(trace!, {
                precipitationLastHour: mm(0),
                precipitationLast3Hours: mm(0),
                precipitationLast6Hours: mm(null),
              }),
              observationFeature(dry!),
              { properties: fiveMinuteProperties },
            ],
          }),
      });

      const { data, text } = successOf(await runToolContract(tool, { station_id: 'KSEA' }));

      expect(
        data.observations.map((o) => [
          o.precipitationLastHourMm,
          o.precipitationLast3HoursMm,
          o.precipitationLast6HoursMm,
        ]),
      ).toEqual([
        [3.3, 6.1, null],
        [0, 0, null],
        [null, null, null],
        [null, null, null],
      ]);
      expect(text).toContain('| Precipitation |');
      const rows = text.split('\n').filter((line) => /^\| [A-Z][a-z]{2}, /.test(line));
      const precipitationCell = (row: string) => row.split(' | ')[10];
      expect(rows.map(precipitationCell)).toEqual([
        '1 h: 0.13 in (3.3 mm), 3 h: 0.24 in (6.1 mm)',
        '1 h: Trace, 3 h: Trace',
        '—',
        '—',
      ]);
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
        precipitationLastHourMm: null,
        precipitationLast3HoursMm: null,
        precipitationLast6HoursMm: null,
        cloudLayers: [],
      });
      expect(text).toContain(
        `| ${formatTimestamp(ts!, 'America/Los_Angeles')} | — | — | — | — | — | — | — | — | — | — | — |`,
      );
    });

    it('renders a reported gust whose sustained speed is null, and — only when no wind is reported (issue #61)', async () => {
      // Wind groups from KDEN 2026-10-23T04:25Z (a 5-minute record): sustained speed
      // and direction null, gust 44.46 km/h. The second row carries a direction
      // alone, which renders with the sustained speed marked not reported, matching
      // nws_get_observations. A row with no wind component at all renders `—`.
      const [gustOnly, directionOnly, noWind] = history(3);
      const nullWind = { value: null, unitCode: 'wmoUnit:km_h-1', qualityControl: 'Z' };
      http.route(stationRoute(), {
        match: (request: Request) => new URL(request.url).pathname === LIST_PATH,
        respond: () =>
          json({
            features: [
              observationFeature(gustOnly!, {
                windSpeed: nullWind,
                windDirection: { value: null, unitCode: 'wmoUnit:degree_(angle)' },
                windGust: { value: 44.46, unitCode: 'wmoUnit:km_h-1', qualityControl: 'S' },
              }),
              observationFeature(directionOnly!, {
                windSpeed: nullWind,
                windDirection: { value: 180, unitCode: 'wmoUnit:degree_(angle)' },
                windGust: nullWind,
              }),
              observationFeature(noWind!, {
                windSpeed: nullWind,
                windDirection: { value: null, unitCode: 'wmoUnit:degree_(angle)' },
                windGust: nullWind,
              }),
            ],
          }),
      });

      const { data, text } = successOf(await runToolContract(tool, { station_id: 'KSEA' }));

      expect(data.observations[0]).toMatchObject({
        windSpeedKmh: null,
        windDirectionDeg: null,
        windGustKmh: 44,
      });
      expect(data.observations[1]).toMatchObject({
        windSpeedKmh: null,
        windDirectionDeg: 180,
        windGustKmh: null,
      });
      const rows = text.split('\n').filter((line) => /^\| [A-Z][a-z]{2}, /.test(line));
      const windCell = (row: string) => row.split(' | ')[5];
      expect(windCell(rows[0]!)).toBe('sustained not reported, gusts 27 mph (44 km/h)');
      expect(windCell(rows[1]!)).toBe('180°, sustained not reported');
      expect(data.observations[2]).toMatchObject({
        windSpeedKmh: null,
        windDirectionDeg: null,
        windGustKmh: null,
      });
      expect(windCell(rows[2]!)).toBe('—');
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
