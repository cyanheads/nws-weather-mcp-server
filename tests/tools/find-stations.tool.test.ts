/**
 * @fileoverview Tests for nws_find_stations tool.
 * @module tests/tools/find-stations
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FindStationsResult } from '@/services/nws/nws-service.js';

const mockFindStations = vi.fn<() => Promise<FindStationsResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ findStations: mockFindStations }),
}));

const { findStationsTool } = await import('@/mcp-server/tools/definitions/find-stations.tool.js');

const stationsResult: FindStationsResult = {
  stations: [
    {
      stationId: 'KSEA',
      name: 'Seattle-Tacoma International Airport',
      distance: 12.3,
      bearing: 'S',
      elevation: { value: 131, unitCode: 'wmoUnit:m' },
      timeZone: 'America/Los_Angeles',
      county: 'https://api.weather.gov/zones/county/WAC033',
      forecastZone: 'https://api.weather.gov/zones/forecast/WAZ558',
    },
    {
      stationId: 'KBFI',
      name: 'Seattle Boeing Field',
      distance: 5.1,
      bearing: 'SE',
      elevation: { value: 6, unitCode: 'wmoUnit:m' },
      timeZone: 'America/Los_Angeles',
      county: 'https://api.weather.gov/zones/county/WAC033',
      forecastZone: 'https://api.weather.gov/zones/forecast/WAZ558',
    },
  ],
};

describe('nws_find_stations', () => {
  it.each([' { "offset": 1, "limit": 1 } \n', '{"offset":1,"limit":1,"x":"???"}'])(
    'keeps legacy padded standard-base64 tokens and extra fields: %s',
    async (json) => {
      mockFindStations.mockResolvedValue(stationsResult);
      const result = await runToolContract(findStationsTool, {
        latitude: 47.6,
        longitude: -122.3,
        cursor: Buffer.from(json).toString('base64'),
        limit: 50,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        stations: [{ stationId: 'KBFI' }],
        totalCount: 2,
        shown: 1,
      });
      expect(result.structuredContent).not.toHaveProperty('nextCursor');
    },
  );
  it.each([
    '{"offset":0,"limit":0.5}',
    '{"offset":0.5,"limit":10}',
    '{"offset":1e999,"limit":10}',
    '{"offset":0,"limit":1e999}',
  ])('rejects malformed numeric cursor before lookup: %s', async (json) => {
    mockFindStations.mockResolvedValue(stationsResult);
    const result = await runToolContract(findStationsTool, {
      latitude: 47.6,
      longitude: -122.3,
      cursor: Buffer.from(json).toString('base64'),
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_cursor' } },
    });
    expect(mockFindStations).not.toHaveBeenCalled();
  });

  it('normalizes a whitespace cursor before first-page clamping', async () => {
    mockFindStations.mockResolvedValue(stationsResult);
    const result = await runToolContract(findStationsTool, {
      latitude: 47.6,
      longitude: -122.3,
      cursor: '   ',
      limit: 51,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      shown: 2,
      requestedLimit: 51,
      effectiveLimit: 50,
    });
  });
  beforeEach(() => {
    mockFindStations.mockReset();
  });

  it('parses input with default limit', () => {
    const input = findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    expect(input.limit).toBe(10);
  });

  it('accepts a limit past the page cap up to the 10000 ceiling, and rejects beyond it', () => {
    expect(
      findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 100 }).limit,
    ).toBe(100);
    expect(
      findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 10_000 }).limit,
    ).toBe(10_000);
    expect(() =>
      findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 10_001 }),
    ).toThrow();
  });

  it('returns stations with distance and bearing', async () => {
    mockFindStations.mockResolvedValueOnce(stationsResult);

    const ctx = createMockContext({ tenantId: 'test', errors: findStationsTool.errors });
    const input = findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    const result = await findStationsTool.handler(input, ctx);

    expect(result.stations).toHaveLength(2);
    expect(result.stations[0]!.stationId).toBe('KSEA');
    expect(result.stations[0]!.distanceKm).toBe(12.3);
    expect(result.stations[0]!.bearing).toBe('S');
    expect(result.stations[1]!.elevationM).toBe(6);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(2);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.notice).toBeUndefined();
  });

  it('sets enrichment notice when no stations found', async () => {
    mockFindStations.mockResolvedValueOnce({ stations: [] });

    const ctx = createMockContext({ tenantId: 'test', errors: findStationsTool.errors });
    const input = findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    const result = await findStationsTool.handler(input, ctx);

    expect(result.stations).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.shown).toBe(0);
    expect(enrichment.notice).toContain('No observation stations found');
  });

  it('applies limit as the page size instead of passing it to the service', async () => {
    // The service returns every nearby station so the handler can offer a next
    // page; `limit` sizes the window the handler takes from that array.
    mockFindStations.mockResolvedValueOnce({
      stations: Array.from({ length: 12 }, (_, index) => ({
        stationId: `K${index}`,
        name: `Station ${index}`,
        distance: index,
        bearing: 'N',
        elevation: { value: 10, unitCode: 'wmoUnit:m' },
        timeZone: 'America/Los_Angeles',
        county: 'WAC033',
        forecastZone: 'WAZ558',
      })),
    });

    const ctx = createMockContext({ tenantId: 'test', errors: findStationsTool.errors });
    const input = findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 5 });
    const result = await findStationsTool.handler(input, ctx);

    expect(mockFindStations).toHaveBeenCalledWith(47.6, -122.3, ctx);
    expect(result.stations).toHaveLength(5);
    expect(getEnrichment(ctx).totalCount).toBe(12);
  });

  describe('cursor pagination (issue #28)', () => {
    /** Build a distance-sorted station list of `count` distinguishable entries. */
    function stationList(count: number): FindStationsResult {
      return {
        stations: Array.from({ length: count }, (_, index) => ({
          stationId: `K${String(index).padStart(3, '0')}`,
          name: `Station ${index + 1}`,
          distance: index + 1,
          bearing: 'N',
          elevation: { value: 10, unitCode: 'wmoUnit:m' },
          timeZone: 'America/Los_Angeles',
          county: 'WAC033',
          forecastZone: 'WAZ558',
        })),
      };
    }

    /** Run one page against the currently mocked station list. */
    async function page(limit: number, cursor?: string) {
      const ctx = createMockContext({ tenantId: 'test', errors: findStationsTool.errors });
      const input = findStationsTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const result = await findStationsTool.handler(input, ctx);
      return { result, enrichment: getEnrichment(ctx) };
    }

    it('offers a nextCursor and a truncation notice when stations remain beyond the limit', async () => {
      mockFindStations.mockResolvedValue(stationList(73));

      const { result, enrichment } = await page(50);

      expect(result.stations).toHaveLength(50);
      expect(enrichment.nextCursor).toEqual(expect.any(String));
      expect(enrichment.notice).toContain('cursor');
    });

    it('walks consecutive pages over one fetched list with no overlap and no gaps', async () => {
      mockFindStations.mockResolvedValue(stationList(73));

      const seen: string[] = [];
      const pageSizes: number[] = [];
      let cursor: string | undefined;
      do {
        const { result, enrichment } = await page(30, cursor);
        seen.push(...result.stations.map((s) => s.stationId));
        pageSizes.push(result.stations.length);
        cursor = enrichment.nextCursor as string | undefined;
      } while (cursor);

      expect(pageSizes).toEqual([30, 30, 13]);
      expect(seen).toEqual(
        Array.from({ length: 73 }, (_, index) => `K${String(index).padStart(3, '0')}`),
      );
      expect(new Set(seen).size).toBe(73);
    });

    it('keeps totalCount at the full pre-limit count on every page (contract: issue #14)', async () => {
      mockFindStations.mockResolvedValue(stationList(73));

      const first = await page(30);
      const second = await page(30, first.enrichment.nextCursor as string);

      expect(first.enrichment.totalCount).toBe(73);
      expect(second.enrichment.totalCount).toBe(73);
      // The disclosure #14 protects is the gap between the two counts: a caller
      // comparing them learns stations were withheld. `totalCount` tracking the
      // page size would collapse that gap and report a truncated list as whole.
      expect(first.enrichment.totalCount).not.toBe(first.result.stations.length);
      expect(second.enrichment.totalCount).not.toBe(second.result.stations.length);
    });

    it('keeps shown the per-page returned count, not the pre-limit total', async () => {
      mockFindStations.mockResolvedValue(stationList(73));

      const first = await page(30);
      const last = await page(30, encodeCursor({ offset: 60, limit: 30 }));

      expect(first.enrichment.shown).toBe(30);
      expect(last.enrichment.shown).toBe(13);
    });

    it('omits nextCursor entirely when every station fits one page', async () => {
      mockFindStations.mockResolvedValue(stationList(4));

      const { result, enrichment } = await page(10);

      expect(result.stations).toHaveLength(4);
      expect(enrichment).not.toHaveProperty('nextCursor');
      expect(enrichment.notice).toBeUndefined();
    });

    it('omits nextCursor when the final page ends exactly on the list length', async () => {
      mockFindStations.mockResolvedValue(stationList(20));

      const first = await page(10);
      expect(first.enrichment.nextCursor).toEqual(expect.any(String));

      const second = await page(10, first.enrichment.nextCursor as string);
      expect(second.result.stations).toHaveLength(10);
      expect(second.result.stations[9]!.stationId).toBe('K019');
      expect(second.enrichment).not.toHaveProperty('nextCursor');
    });

    it('returns an empty page for a cursor whose offset equals the list length', async () => {
      mockFindStations.mockResolvedValue(stationList(20));

      const { result, enrichment } = await page(10, encodeCursor({ offset: 20, limit: 10 }));

      expect(result.stations).toHaveLength(0);
      expect(enrichment.totalCount).toBe(20);
      expect(enrichment.shown).toBe(0);
      expect(enrichment).not.toHaveProperty('nextCursor');
      expect(enrichment.notice).toContain('past the end');
    });

    it('returns an empty page for a cursor past the end of the list', async () => {
      mockFindStations.mockResolvedValue(stationList(20));

      const { result, enrichment } = await page(10, encodeCursor({ offset: 500, limit: 10 }));

      expect(result.stations).toHaveLength(0);
      expect(enrichment).not.toHaveProperty('nextCursor');
      expect(enrichment.notice).toContain('past the end');
    });

    it('clamps an oversized cursor page size to the 50-station bound', async () => {
      mockFindStations.mockResolvedValue(stationList(73));

      const { result, enrichment } = await page(10, encodeCursor({ offset: 0, limit: 1000 }));

      expect(result.stations).toHaveLength(50);
      expect(enrichment.shown).toBe(50);
      expect(enrichment.totalCount).toBe(73);
    });

    it('rejects a malformed cursor with InvalidParams (-32602), per the MCP pagination spec', async () => {
      mockFindStations.mockResolvedValue(stationList(20));

      const ctx = createMockContext({ tenantId: 'test', errors: findStationsTool.errors });
      const input = findStationsTool.input.parse({
        latitude: 47.6,
        longitude: -122.3,
        cursor: 'not-a-real-cursor',
      });

      await expect(findStationsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
      });
    });

    it('treats an empty-string cursor as the first page (form-based clients)', async () => {
      mockFindStations.mockResolvedValue(stationList(73));

      const { result, enrichment } = await page(10, '');

      expect(result.stations[0]!.stationId).toBe('K000');
      expect(enrichment.shown).toBe(10);
    });

    describe('limit past the 50-station cap (issue #53)', () => {
      type Surfaces = {
        data: Record<string, unknown> & { stations: { stationId: string }[] };
        text: string;
      };

      /** One call through the production parse, returning both client surfaces. */
      async function call(args: Record<string, unknown>): Promise<Surfaces> {
        const result = await runToolContract(findStationsTool, {
          latitude: 47.6,
          longitude: -122.3,
          ...args,
        });
        expect(result.isError).toBeFalsy();
        return {
          data: result.structuredContent as Surfaces['data'],
          text: result.content.map((block) => (block as { text: string }).text).join('\n'),
        };
      }

      const CLAMP = 'Requested limit 51 exceeds the per-page cap of 50; this page holds up to 50.';

      it('serves 50 of 60, discloses the clamp on both surfaces, and continues to the other 10', async () => {
        mockFindStations.mockResolvedValue(stationList(60));

        const first = await call({ limit: 51 });

        expect(first.data.stations).toHaveLength(50);
        expect(first.data).toMatchObject({
          totalCount: 60,
          shown: 50,
          requestedLimit: 51,
          effectiveLimit: 50,
        });
        expect(first.data.nextCursor).toEqual(expect.any(String));
        // One notice: the clamp first, then the page's own continuation guidance.
        const notice = `${CLAMP} Returning 50 of 60 nearby stations. Pass nextCursor back as cursor for the next page. Stations are contiguous within one response; the list is re-fetched on every call, so a later call can window an updated registry.`;
        expect(first.data.notice).toBe(notice);
        expect(first.text).toContain(notice);
        expect(first.text).toContain('**Requested Limit:** 51');
        expect(first.text).toContain('**Applied Limit:** 50');

        const second = await call({ cursor: first.data.nextCursor });

        expect(second.data.stations.map((s) => s.stationId)).toEqual(
          Array.from({ length: 10 }, (_, index) => `K0${50 + index}`),
        );
        expect(second.data).not.toHaveProperty('nextCursor');
        expect(second.data).not.toHaveProperty('notice');
        expect(second.data).not.toHaveProperty('requestedLimit');
        expect(second.data).not.toHaveProperty('effectiveLimit');
      });

      it('discloses the clamp alone when every station fits one page', async () => {
        mockFindStations.mockResolvedValue(stationList(12));

        const { data } = await call({ limit: 10_000 });

        expect(data.stations).toHaveLength(12);
        expect(data).toMatchObject({ requestedLimit: 10_000, effectiveLimit: 50 });
        expect(data.notice).toBe(
          'Requested limit 10000 exceeds the per-page cap of 50; this page holds up to 50.',
        );
      });

      it('returns a limit within the cap exactly as before, with no clamp disclosure', async () => {
        mockFindStations.mockResolvedValue(stationList(60));

        const { data, text } = await call({ limit: 50 });

        expect(data.stations).toHaveLength(50);
        expect(data).not.toHaveProperty('requestedLimit');
        expect(data).not.toHaveProperty('effectiveLimit');
        // The continuation guidance alone, with no clamp sentence ahead of it.
        expect(data.notice).toBe(
          'Returning 50 of 60 nearby stations. Pass nextCursor back as cursor for the next page. Stations are contiguous within one response; the list is re-fetched on every call, so a later call can window an updated registry.',
        );
        expect(text).not.toContain('**Requested Limit:**');
        expect(text).not.toContain('**Applied Limit:**');
      });

      it('continues a cursor at its own page size when a different limit is sent with it, disclosing nothing', async () => {
        mockFindStations.mockResolvedValue(stationList(60));

        const first = await call({ limit: 20 });
        const second = await call({ cursor: first.data.nextCursor, limit: 500 });

        expect(second.data.stations).toHaveLength(20);
        expect(second.data.stations[0]!.stationId).toBe('K020');
        expect(second.data).not.toHaveProperty('requestedLimit');
        expect(second.data).not.toHaveProperty('effectiveLimit');
      });

      it.each([
        ['past the 10000 ceiling', 10_001],
        ['zero', 0],
        ['fractional', 2.5],
      ])('rejects a limit %s as invalid_arguments', async (_label, limit) => {
        const result = await runToolContract(findStationsTool, {
          latitude: 47.6,
          longitude: -122.3,
          limit,
        });
        const { error } = result.structuredContent as {
          error: { code: number; data?: { reason?: string } };
        };

        expect(result.isError).toBe(true);
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data?.reason).toBe('invalid_arguments');
        expect(mockFindStations).not.toHaveBeenCalled();
      });
    });

    it('renders the cursor-selected window in format(), not the first window', async () => {
      mockFindStations.mockResolvedValue(stationList(73));

      const first = await page(30);
      const second = await page(30, first.enrichment.nextCursor as string);

      const blocks = findStationsTool.format!(second.result);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('K030');
      expect(text).toContain('K059');
      expect(text).not.toContain('K029');
      expect(text).not.toContain('K060');
    });
  });

  describe('format', () => {
    it('renders markdown table', () => {
      const output = {
        stations: [
          {
            stationId: 'KSEA',
            name: 'Seattle-Tacoma Intl',
            distanceKm: 12.3,
            bearing: 'S',
            elevationM: 131,
            timeZone: 'America/Los_Angeles',
            county: 'WAC033',
            forecastZone: 'WAZ558',
          },
        ],
      };

      const blocks = findStationsTool.format!(output);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('KSEA');
      expect(text).toContain('12.3 km');
      expect(text).toContain('131m');
      // Should have table headers
      expect(text).toContain('Station');
      expect(text).toContain('Distance');
    });

    it('renders fallback message for empty results', () => {
      const blocks = findStationsTool.format!({ stations: [] });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No stations found');
    });
  });
});
