/**
 * @fileoverview Tests for nws_find_stations tool.
 * @module tests/tools/find-stations
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
  beforeEach(() => {
    mockFindStations.mockReset();
  });

  it('parses input with default limit', () => {
    const input = findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    expect(input.limit).toBe(10);
  });

  it('rejects limit out of range', () => {
    expect(() =>
      findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 100 }),
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
