/**
 * @fileoverview Tests for the NWS API service layer.
 * @module tests/services/nws/nws-service
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alertsResponse,
  alertTypesResponse,
  emptyAlertsResponse,
  forecastResponse,
  observationResponse,
  pointsResponse,
  stationInfoResponse,
  stationsResponse,
} from '../../fixtures/nws-responses.js';

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

vi.stubGlobal('fetch', mockFetch);

/** Helper: create a mock Response from a JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/geo+json' },
  });
}

describe('NwsService', () => {
  let service: Awaited<typeof import('@/services/nws/nws-service.js')>;

  beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockReset();

    delete process.env.NWS_USER_AGENT;
    service = await import('@/services/nws/nws-service.js');
    service.initNwsService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getForecast', () => {
    it('resolves points then fetches forecast', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse(forecastResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getForecast(47.6062, -122.3321, false, ctx);

      expect(result.location.city).toBe('Seattle');
      expect(result.location.state).toBe('WA');
      expect(result.location.office).toBe('SEW');
      expect(result.location.forecastZone).toBe('WAZ558');
      expect(result.location.county).toBe('WAC033');
      expect(result.forecast.periods).toHaveLength(2);
      expect(result.forecast.periods[0].name).toBe('Today');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('uses cached points on second call', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse(forecastResponse))
        .mockResolvedValueOnce(jsonResponse(forecastResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      await service.getNwsService().getForecast(47.6062, -122.3321, false, ctx);
      await service.getNwsService().getForecast(47.6062, -122.3321, false, ctx);

      // Points fetched once, forecast fetched twice
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('fetches hourly forecast URL when hourly=true', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse(forecastResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      await service.getNwsService().getForecast(47.6062, -122.3321, true, ctx);

      const secondCall = mockFetch.mock.calls[1];
      expect(secondCall[0]).toContain('forecast/hourly');
    });
  });

  describe('searchAlerts', () => {
    it('returns alerts matching filters', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(alertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service
        .getNwsService()
        .searchAlerts({ area: 'WA', event: ['wind'], status: 'Actual' }, ctx);

      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].event).toBe('Wind Advisory');
      expect(result.alerts[0].severity).toBe('Moderate');
    });

    it('normalizes each supported status value to lowercase for the upstream API', async () => {
      mockFetch.mockImplementation(async () => jsonResponse(emptyAlertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const statuses = ['Actual', 'Exercise', 'System', 'Test', 'Draft'] as const;

      for (const status of statuses) {
        await service.getNwsService().searchAlerts({ status }, ctx);
      }

      const urls = mockFetch.mock.calls.map(([url]) => String(url));
      expect(urls).toEqual(
        statuses.map(
          (status) => `https://api.weather.gov/alerts/active?status=${status.toLowerCase()}`,
        ),
      );
    });

    it('returns empty array when no alerts', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(emptyAlertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().searchAlerts({}, ctx);

      expect(result.alerts).toHaveLength(0);
    });

    it('passes query params to the API and keeps event matching local', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(emptyAlertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      await service
        .getNwsService()
        .searchAlerts(
          { area: 'WA', severity: ['Severe', 'Extreme'], event: ['tornado'], status: 'Actual' },
          ctx,
        );

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('area=WA');
      expect(url).toContain('severity=Severe%2CExtreme');
      expect(url).toContain('status=actual');
      expect(url).not.toContain('event=');
    });

    it('maps upstream 400 responses to validation errors', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ title: 'Bad Request', detail: 'Invalid alert query' }, 400),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().searchAlerts({}, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      await expect(result).rejects.toThrow('Invalid alert query');
    });

    it('maps upstream parameterErrors to actionable validation errors', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            correlationId: '5ac24233',
            parameterErrors: [
              {
                parameter: 'query.area',
                message: 'parameters may not be used together: area, point',
              },
            ],
            title: 'Bad Request',
            detail: 'Bad Request',
            status: 400,
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/problem+json' },
          },
        ),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().searchAlerts({}, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      await expect(result).rejects.toThrow('parameters may not be used together: area, point');
    });

    it('maps title-only upstream 400 responses to validation errors', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ title: 'Bad Request' }, 400));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().searchAlerts({}, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      await expect(result).rejects.toThrow('Bad Request');
    });

    it('maps plain-text upstream 400 responses to validation errors', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Upstream rejected the query', {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().searchAlerts({}, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      await expect(result).rejects.toThrow('NWS API returned 400: Bad Request');
    });
  });

  describe('getObservation', () => {
    it('fetches by station ID directly', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(stationInfoResponse))
        .mockResolvedValueOnce(jsonResponse(observationResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getObservation({ stationId: 'KSEA' }, ctx);

      expect(result.observation.stationId).toBe('KSEA');
      expect(result.observation.stationName).toBe('Seattle, Seattle-Tacoma International Airport');
      expect(result.observation.timeZone).toBe('America/Los_Angeles');
      expect(result.observation.temperature.value).toBe(14.4);
      expect(result.observation.textDescription).toBe('Mostly Cloudy');
    });

    it('resolves nearest station from coordinates', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse(stationsResponse))
        .mockResolvedValueOnce(jsonResponse(observationResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service
        .getNwsService()
        .getObservation({ latitude: 47.6062, longitude: -122.3321 }, ctx);

      expect(result.observation.stationId).toBe('KBFI');
    });

    it('selects the nearest station instead of the first returned station', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(
          jsonResponse({
            features: [
              stationsResponse.features[0],
              stationsResponse.features[2],
              stationsResponse.features[1],
            ],
          }),
        )
        .mockResolvedValueOnce(jsonResponse(observationResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service
        .getNwsService()
        .getObservation({ latitude: 47.6062, longitude: -122.3321 }, ctx);

      expect(result.observation.stationId).toBe('KBFI');
    });

    it('throws notFound when a station ID does not exist', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 404))
        .mockResolvedValueOnce(jsonResponse({}, 404));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getObservation({ stationId: 'ZZZZ' }, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
      await expect(result).rejects.toThrow("Station 'ZZZZ' not found");
    });

    it('throws notFound when the station has no recent observations', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(stationInfoResponse)).mockResolvedValueOnce(
        jsonResponse({
          ...observationResponse,
          properties: {
            ...observationResponse.properties,
            timestamp: null,
          },
        }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getObservation({ stationId: 'KSEA' }, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
      await expect(result).rejects.toThrow('has no recent observations');
    });

    it('throws notFound when the nearest station has no recent observations', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse(stationsResponse))
        .mockResolvedValueOnce(
          jsonResponse({
            ...observationResponse,
            properties: {
              ...observationResponse.properties,
              timestamp: null,
            },
          }),
        );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service
        .getNwsService()
        .getObservation({ latitude: 47.6062, longitude: -122.3321 }, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
      await expect(result).rejects.toThrow('has no recent observations');
    });

    it('throws when no stations found', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse({ features: [] }));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service
        .getNwsService()
        .getObservation({ latitude: 47.6, longitude: -122.3 }, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
      await expect(result).rejects.toThrow('No observation stations found');
    });
  });

  describe('findStations', () => {
    it('returns stations sorted by proximity', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse(stationsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().findStations(47.6062, -122.3321, 10, ctx);

      expect(result.stations.length).toBeGreaterThan(0);
      expect(result.stations[0].stationId).toBeDefined();
      // Each station should have distance and bearing
      for (const s of result.stations) {
        expect(s.distance).toBeGreaterThanOrEqual(0);
        expect(s.bearing).toBeTruthy();
      }
    });

    it('respects the limit parameter', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse(stationsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().findStations(47.6062, -122.3321, 1, ctx);

      expect(result.stations).toHaveLength(1);
    });
  });

  describe('listAlertTypes', () => {
    it('returns event type names', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(alertTypesResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const types = await service.getNwsService().listAlertTypes(ctx);

      expect(types).toContain('Tornado Warning');
      expect(types).toContain('Wind Advisory');
      expect(types.length).toBe(6);
    });
  });

  describe('error handling', () => {
    let origSetTimeout: typeof globalThis.setTimeout;

    beforeEach(() => {
      origSetTimeout = globalThis.setTimeout;
      // Skip retry delays in tests
      vi.stubGlobal('setTimeout', (fn: () => void) => origSetTimeout(fn, 0));
    });

    afterEach(() => {
      vi.stubGlobal('setTimeout', origSetTimeout);
    });

    it('throws descriptive error on 404', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getForecast(99.0, 0.0, false, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      await expect(result).rejects.toThrow('NWS only covers the US');
    });

    it('throws serviceUnavailable when the forecast response is HTML instead of JSON', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(pointsResponse)).mockImplementation(
        async () =>
          new Response('<!DOCTYPE html><html><body>Service unavailable</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getForecast(47.6062, -122.3321, false, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      await expect(result).rejects.toThrow('NWS API returned HTML instead of JSON');
    });

    it('throws serviceUnavailable when /points omits required URLs', async () => {
      mockFetch.mockImplementation(async () =>
        jsonResponse({
          properties: {
            gridId: 'SEW',
            gridX: 123,
            gridY: 45,
            relativeLocation: {
              properties: {
                city: 'Seattle',
                state: 'WA',
              },
            },
            timeZone: 'America/Los_Angeles',
          },
        }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getForecast(47.6062, -122.3321, false, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      await expect(result).rejects.toThrow('NWS /points response missing required URLs');
    });

    it('preserves rateLimited errors after repeated 429 responses', async () => {
      mockFetch.mockImplementation(
        async () =>
          new Response('', {
            status: 429,
            statusText: 'Too Many Requests',
          }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().searchAlerts({}, ctx);

      await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      await expect(result).rejects.toThrow('rate-limited the request');
    });

    it('retries on 500 and succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse(forecastResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getForecast(47.6062, -122.3321, false, ctx);

      expect(result.forecast.periods).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('retries on transient network errors and succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(jsonResponse(forecastResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().getForecast(47.6062, -122.3321, false, ctx);

      expect(result.forecast.periods).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('throws serviceUnavailable after max retries', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({}, 500))
        .mockResolvedValueOnce(jsonResponse({}, 500));

      const ctx = createMockContext({ tenantId: 'test' });
      await expect(
        service.getNwsService().getForecast(47.6062, -122.3321, false, ctx),
      ).rejects.toThrow();
    });
  });

  describe('init/accessor', () => {
    it('throws if service not initialized', async () => {
      vi.resetModules();
      const fresh = await import('@/services/nws/nws-service.js');
      expect(() => fresh.getNwsService()).toThrow('not initialized');
    });
  });
});
