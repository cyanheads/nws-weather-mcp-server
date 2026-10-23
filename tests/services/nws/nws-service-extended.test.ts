/**
 * @fileoverview Extended service-layer tests for NWS API error handling and edge cases.
 * @module tests/services/nws/nws-service-extended
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
    // A request no test queued a response for fails loudly instead of reaching live NWS.
    mockFetch.mockImplementation(async (input) => {
      throw new Error(`Unmocked fetch: ${String(input)}`);
    });

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

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'no_products',
          recovery: {
            hint: 'Use nws_get_forecast with coordinates to find the office code (the "office" field in the location object), then retry with that value.',
          },
        },
      });
      // The message names the field nws_get_forecast actually returns (issue #69).
      const { message } = (await result.catch((e: unknown) => e)) as Error;
      expect(message).toBe(
        'No AFD products found for office "BOGUS". Verify the 3-letter WFO code (e.g., "SEW" for Seattle). The office code is the "location.office" field of nws_get_forecast output.',
      );
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

    describe('empty product list for a valid office, per product type (issue #59)', () => {
      /** Routes the list and office-probe requests by host and path; anything else is unmocked. */
      const routeEmptyList = (office: string, productType: string) =>
        mockFetch.mockImplementation(async (input) => {
          const url = new URL(String(input));
          if (url.hostname !== 'api.weather.gov') throw new Error(`unmocked fetch: ${url}`);
          if (url.pathname === `/products/types/${productType}/locations/${office}`) {
            return jsonResponse({ '@graph': [] });
          }
          if (url.pathname === `/offices/${office}`) return jsonResponse({ id: office });
          throw new Error(`unmocked fetch: ${url}`);
        });

      it.each(['HWO', 'SPS'])('calls %s episodic', async (productType) => {
        routeEmptyList('SEW', productType);
        const ctx = createMockContext({ tenantId: 'test' });
        const error = await service
          .getNwsService()
          .getOfficeDiscussion('SEW', productType, ctx)
          .catch((e: unknown) => e);

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'no_products',
            office: 'SEW',
            productType,
            recovery: {
              hint: `${productType} products are issued only when conditions warrant. Retry with product_type "AFD" for the always-available forecast discussion.`,
            },
          },
        });
        expect((error as Error).message).toBe(
          `No ${productType} products are currently available for office "SEW". ${productType} products are episodic — most offices have none active most of the time. Try a different product type (AFD is near-always available).`,
        );
      });

      it.each(['AFD', 'ZFP'])(
        'says no %s is filed under the location code and names the Anchorage ZFP codes',
        async (productType) => {
          routeEmptyList('AFC', productType);
          const ctx = createMockContext({ tenantId: 'test' });
          const error = (await service
            .getNwsService()
            .getOfficeDiscussion('AFC', productType, ctx)
            .catch((e: unknown) => e)) as { message: string; data: Record<string, unknown> };

          expect(error).toMatchObject({
            code: JsonRpcErrorCode.NotFound,
            data: { reason: 'no_products', office: 'AFC', productType },
          });
          // Neither the message nor the hint calls a routine product episodic.
          expect(error.message).toBe(
            `No ${productType} product is filed under location code "AFC". Some offices file a product under location codes other than their WFO code — Anchorage (AFC) files its ZFP under "AER" (Anchorage East) and "ALU" (Anchorage West), and San Juan (SJU) its ZFP under "PR".`,
          );
          expect((error.data.recovery as { hint: string }).hint).toBe(
            productType === 'ZFP'
              ? 'Retry with the location code the office files its ZFP under (Anchorage: "AER" or "ALU"; San Juan: "PR"), or use nws_get_zone_forecast with a zone code for one zone\'s text forecast.'
              : // No office files its AFD under another code, so the hint names none.
                'Confirm the WFO code from the "office" field of nws_get_forecast output and retry with it.',
          );
        },
      );

      it('says an office with no FWF on file issues none, naming no alternate location code (issue #67)', async () => {
        routeEmptyList('AFC', 'FWF');
        const ctx = createMockContext({ tenantId: 'test' });
        const error = (await service
          .getNwsService()
          .getOfficeDiscussion('AFC', 'FWF', ctx)
          .catch((e: unknown) => e)) as { message: string; data: Record<string, unknown> };

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.NotFound,
          data: { reason: 'no_products', office: 'AFC', productType: 'FWF' },
        });
        expect(error.message).toBe(
          'Office "AFC" has no FWF (Fire Weather Planning Forecast) on file — not every Weather Forecast Office issues one.',
        );
        // Unlike the AFD/ZFP hint above, it names no alternate location code.
        expect((error.data.recovery as { hint: string }).hint).toBe(
          'Retry with product_type "AFD" for this office\'s forecast discussion. For a fire zone from an alert, use the office in that alert\'s "office" field with product_type "FWF".',
        );
      });
    });

    it('fetches the latest FWF from the office product list (issue #67)', async () => {
      mockFetch.mockImplementation(async (input) => {
        const url = String(input);
        if (url === 'https://api.weather.gov/products/types/FWF/locations/RIW') {
          return jsonResponse({ '@graph': [{ id: 'fwf-riw-1', productCode: 'FWF' }] });
        }
        if (url === 'https://api.weather.gov/products/fwf-riw-1') {
          return jsonResponse({
            ...productDetailResponse,
            issuingOffice: 'KRIW',
            productCode: 'FWF',
            productName: 'Routine Fire Wx Fcst (With/Without 6-10 Day Outlook)',
            productText: 'FNUS55 KRIW 230731\nFWFRIW\n\n.DISCUSSION...',
            wmoCollectiveId: 'FNUS55',
          });
        }
        throw new Error(`unmocked fetch: ${url}`);
      });

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getOfficeDiscussion('RIW', 'FWF', ctx);
      expect(result).toMatchObject({
        productCode: 'FWF',
        issuingOffice: 'KRIW',
        productText: 'FNUS55 KRIW 230731\nFWFRIW\n\n.DISCUSSION...',
      });
      expect(mockFetch.mock.calls.map(([url]) => String(url))).toEqual([
        'https://api.weather.gov/products/types/FWF/locations/RIW',
        'https://api.weather.gov/products/fwf-riw-1',
      ]);
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
      expect(result.periods[0]!.name).toBe('Today');
      expect(result.periods[0]!.number).toBe(1);
      expect(result.periods[1]!.name).toBe('Tonight');
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

    it('puts the tool contract recovery on the wire, naming the forecast zone type (issue #31)', async () => {
      // The throw lives here but the recovery text belongs to the tool's
      // zone_not_found contract. A second hardcoded copy in this file is what
      // kept pointing callers at untyped affectedZones after the tool was fixed,
      // so the service throw carries only the reason and the tool boundary
      // fills the hint — runToolContract applies that fill as production does.
      const { getZoneForecastTool } = await import(
        '@/mcp-server/tools/definitions/get-zone-forecast.tool.js'
      );
      const contractRecovery = getZoneForecastTool.errors!.find(
        (e) => e.reason === 'zone_not_found',
      )!.recovery;

      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 404))
        .mockResolvedValueOnce(jsonResponse({}, 404))
        .mockResolvedValueOnce(jsonResponse({}, 404));

      const result = await runToolContract(getZoneForecastTool, { zone_id: 'WAC033' });
      const error = (
        result.structuredContent as {
          error: { data?: { reason?: string; recovery?: { hint?: string } }; message: string };
        }
      ).error;

      expect(result.isError).toBe(true);
      expect(error.data?.reason).toBe('zone_not_found');
      expect(error.data?.recovery?.hint).toBe(contractRecovery);
      expect(error.data?.recovery?.hint).toMatch(/type.*forecast/i);
      // The message names the same discriminator, for clients that read only it.
      expect(error.message).toMatch(/type "forecast"/i);
    });

    it('routes a fire zone code to the office FWF in its message (issue #67)', async () => {
      const { getZoneForecastTool } = await import(
        '@/mcp-server/tools/definitions/get-zone-forecast.tool.js'
      );
      mockFetch.mockImplementation(async () => jsonResponse({}, 404));

      const result = await runToolContract(getZoneForecastTool, { zone_id: 'WYZ281' });
      const { error } = result.structuredContent as {
        error: { data?: { reason?: string }; message: string };
      };

      expect(result.isError).toBe(true);
      expect(error.data?.reason).toBe('zone_not_found');
      expect(error.message).toBe(
        'Zone "WYZ281" is not an NWS forecast zone. Provide a forecast zone code (e.g., "WAZ315"). Forecast zone codes are returned by nws_get_forecast (the "forecastZone" field), nws_find_stations (the "forecastZone" column), and nws_search_alerts as "affectedZones" entries with type "forecast" — county zones have no text forecast product. A fire zone from an alert has its forecast in a segment of the office\'s Fire Weather Planning Forecast: call nws_get_office_discussion with office set to the alert\'s "office" field, product_type "FWF", and sections set to the zone code.',
      );
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
      const result = await service.getNwsService().findStations(47.6062, -122.3321, ctx);

      expect(result.stations).toHaveLength(0);
    });

    it('hands back the full station set rather than truncating it', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse(stationsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().findStations(47.6062, -122.3321, ctx);

      // The pre-page total nws_find_stations reports as `totalCount` is this
      // array's length, so a short array here would understate it on every page.
      expect(result.stations).toHaveLength(stationsResponse.features.length);
    });

    it('retries on transient 500 on observation stations fetch', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse(stationsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().findStations(47.6062, -122.3321, ctx);

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

      await expect(result).rejects.toThrow();
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
