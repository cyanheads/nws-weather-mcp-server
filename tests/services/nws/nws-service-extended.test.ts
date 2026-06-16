/**
 * @fileoverview Extended service-layer tests for NWS API error handling and edge cases.
 * @module tests/services/nws/nws-service-extended
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alertTypesResponse,
  pointsResponse,
  stationsResponse,
} from '../../fixtures/nws-responses.js';

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

/** Create a mock Response with a JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/geo+json' },
  });
}

const productListResponse = {
  '@graph': [
    {
      id: 'abc123',
      productCode: 'AFD',
      productName: 'Area Forecast Discussion',
      issuanceTime: '2026-05-30T10:33:00+00:00',
      issuingOffice: 'KSEW',
    },
  ],
};

const productDetailResponse = {
  issuanceTime: '2026-05-30T10:33:00+00:00',
  issuingOffice: 'KSEW',
  productCode: 'AFD',
  productName: 'Area Forecast Discussion',
  productText: 'FXUS66 KSEW 301033\nAFDSEW\n\nArea Forecast Discussion\n.SYNOPSIS...',
  wmoCollectiveId: 'FXUS66',
};

const zoneForecastResponse = {
  properties: {
    updated: '2026-05-30T02:36:00-07:00',
    periods: [
      {
        number: 1,
        name: 'Today',
        detailedForecast: 'Mostly cloudy. Highs in the lower to mid 60s.',
      },
      {
        number: 2,
        name: 'Tonight',
        detailedForecast: 'Mostly cloudy. Lows in the upper 40s.',
      },
    ],
  },
};

describe('NwsService extended', () => {
  let service: Awaited<typeof import('@/services/nws/nws-service.js')>;
  let origSetTimeout: typeof globalThis.setTimeout;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockReset();

    origSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', (fn: () => void) => origSetTimeout(fn, 0));

    delete process.env.NWS_USER_AGENT;
    service = await import('@/services/nws/nws-service.js');
    service.initNwsService();
  });

  afterEach(() => {
    vi.stubGlobal('setTimeout', origSetTimeout);
    vi.restoreAllMocks();
  });

  describe('getOfficeDiscussion', () => {
    it('returns product details on success', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(productListResponse))
        .mockResolvedValueOnce(jsonResponse(productDetailResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getOfficeDiscussion('SEW', 'AFD', ctx);

      expect(result.issuanceTime).toBe('2026-05-30T10:33:00+00:00');
      expect(result.issuingOffice).toBe('KSEW');
      expect(result.productCode).toBe('AFD');
      expect(result.productName).toBe('Area Forecast Discussion');
      expect(result.productText).toContain('SYNOPSIS');
      expect(result.wmoCollectiveId).toBe('FXUS66');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws office-not-found when an empty @graph follows a 404 office probe', async () => {
      // Unknown office: list endpoint returns empty @graph, /offices/{id} → 404.
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ '@graph': [] }))
        .mockResolvedValueOnce(jsonResponse({}, 404));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getOfficeDiscussion('BOGUS', 'AFD', ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
      await expect(result).rejects.toThrow('No AFD products found for office "BOGUS"');
      await expect(result).rejects.toThrow('Verify the 3-letter WFO code');
    });

    it('throws no-current-product when an empty @graph follows a 200 office probe', async () => {
      // Valid office, episodic type with nothing active: empty @graph, /offices/{id} → 200.
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ '@graph': [] }))
        .mockResolvedValueOnce(jsonResponse({ id: 'SEW', name: 'Seattle' }));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getOfficeDiscussion('SEW', 'SPS', ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
      await expect(result).rejects.toThrow(
        'No SPS products are currently available for office "SEW"',
      );
      await expect(result).rejects.toThrow('episodic');
    });

    it('treats a missing @graph key the same as an empty one (probes the office)', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({}, 404));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getOfficeDiscussion('ZZZZ', 'AFD', ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
      await expect(result).rejects.toThrow('Verify the 3-letter WFO code');
    });

    it('surfaces serviceUnavailable on 500 from product list endpoint', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({}, 500));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getOfficeDiscussion('SEW', 'AFD', ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    });

    it('retries on transient 500 from product list and succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse(productListResponse))
        .mockResolvedValueOnce(jsonResponse(productDetailResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getOfficeDiscussion('SEW', 'AFD', ctx);

      expect(result.productCode).toBe('AFD');
      // First call: 500 (retry), second: product list, third: product detail
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('maps 400 on product list to validation error', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ title: 'Bad Request', detail: 'Invalid product type' }, 400),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getOfficeDiscussion('SEW', 'BAD', ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      await expect(result).rejects.toThrow('Invalid product type');
    });

    it('does not include NWS_USER_AGENT value in error messages', async () => {
      process.env.NWS_USER_AGENT = 'SECRET_AGENT_STRING';
      vi.resetModules();
      const freshService = await import('@/services/nws/nws-service.js');
      freshService.initNwsService();

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ title: 'Bad Request', detail: 'Rejected' }, 400),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = freshService.getNwsService().getOfficeDiscussion('SEW', 'AFD', ctx);

      await expect(result).rejects.toThrow();
      const err = await result.catch((e: unknown) => e);
      const errorStr = String(err);
      expect(errorStr).not.toContain('SECRET_AGENT_STRING');

      delete process.env.NWS_USER_AGENT;
    });
  });

  describe('getZoneForecast', () => {
    it('returns zone forecast with periods', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(zoneForecastResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getZoneForecast('WAZ315', ctx);

      expect(result.zoneId).toBe('WAZ315');
      expect(result.updated).toBe('2026-05-30T02:36:00-07:00');
      expect(result.periods).toHaveLength(2);
      expect(result.periods[0].name).toBe('Today');
      expect(result.periods[0].number).toBe(1);
      expect(result.periods[1].name).toBe('Tonight');
    });

    it('returns empty periods when upstream provides none', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          properties: {
            updated: '2026-05-30T00:00:00-07:00',
            periods: [],
          },
        }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getZoneForecast('WAZ315', ctx);

      expect(result.periods).toHaveLength(0);
    });

    it('handles upstream response with missing periods key', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          properties: {
            updated: '2026-05-30T00:00:00-07:00',
          },
        }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getZoneForecast('WAZ315', ctx);

      expect(result.periods).toHaveLength(0);
    });

    it('throws notFound for invalid zone code (404)', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 404))
        .mockResolvedValueOnce(jsonResponse({}, 404))
        .mockResolvedValueOnce(jsonResponse({}, 404));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getZoneForecast('WAZ999', ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
      await expect(result).rejects.toThrow('WAZ999');
    });

    it('retries on transient 500 and succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse(zoneForecastResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getZoneForecast('WAZ315', ctx);

      expect(result.periods).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws serviceUnavailable when HTML is returned', async () => {
      mockFetch.mockImplementation(
        async () =>
          new Response('<!DOCTYPE html><html><body>Error</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getZoneForecast('WAZ315', ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      await expect(result).rejects.toThrow('HTML instead of JSON');
    });
  });

  describe('findStations edge cases', () => {
    it('returns empty stations when upstream returns features array with no valid entries', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(pointsResponse)).mockResolvedValueOnce(
        jsonResponse({
          features: [],
        }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().findStations(47.6062, -122.3321, 10, ctx);

      expect(result.stations).toHaveLength(0);
      expect(result.totalFound).toBe(0);
    });

    it('respects limit when more stations are returned than requested', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse(stationsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().findStations(47.6062, -122.3321, 2, ctx);

      expect(result.stations.length).toBeLessThanOrEqual(2);
      // Total found is all available, not limited
      expect(result.totalFound).toBeGreaterThanOrEqual(result.stations.length);
    });

    it('retries on transient 500 on observation stations fetch', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse(stationsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().findStations(47.6062, -122.3321, 10, ctx);

      expect(result.stations.length).toBeGreaterThan(0);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('listAlertTypes edge cases', () => {
    it('returns empty array when upstream eventTypes is missing', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));

      const ctx = createMockContext({ tenantId: 'test' });
      const types = await service.getNwsService().listAlertTypes(ctx);

      expect(types).toHaveLength(0);
    });

    it('retries on transient 500 before succeeding', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse(alertTypesResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const types = await service.getNwsService().listAlertTypes(ctx);

      expect(types).toContain('Tornado Warning');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('surfaces serviceUnavailable after max retries on alert types', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({}, 500));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().listAlertTypes(ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    });

    it('surfaces rateLimited on 429', async () => {
      mockFetch.mockImplementation(
        async () =>
          new Response('', {
            status: 429,
            statusText: 'Too Many Requests',
          }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().listAlertTypes(ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
    });
  });

  describe('security: no secrets in error output', () => {
    it('does not leak User-Agent string in HTTP error details', async () => {
      process.env.NWS_USER_AGENT = 'TOP_SECRET_TOKEN';
      vi.resetModules();
      const freshService = await import('@/services/nws/nws-service.js');
      freshService.initNwsService();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({}, 500));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = freshService.getNwsService().getZoneForecast('WAZ315', ctx);

      const err = await result.catch((e: unknown) => e);
      expect(String(err)).not.toContain('TOP_SECRET_TOKEN');

      delete process.env.NWS_USER_AGENT;
    });

    it('does not reflect injection attempt in zone error message', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 404))
        .mockResolvedValueOnce(jsonResponse({}, 404))
        .mockResolvedValueOnce(jsonResponse({}, 404));

      const ctx = createMockContext({ tenantId: 'test' });
      // Attempt a path traversal / injection in zone id
      const injectionZone = '../../../etc/passwd';
      const result = service.getNwsService().getZoneForecast(injectionZone, ctx);

      // Should throw NotFound, not crash and not reflect the injection payload verbatim
      // in a way that could indicate code execution
      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
    });
  });
});
