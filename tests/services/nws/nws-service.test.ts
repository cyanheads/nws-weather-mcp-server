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
  duplicateAlertsResponse,
  emptyAlertsResponse,
  forecastResponse,
  observationResponse,
  pointsResponse,
  stationInfoResponse,
  stationsResponse,
  updateAlertsResponse,
  zoneTypedAlertsResponse,
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
      expect(result.forecast.periods[0]!.name).toBe('Today');
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

      const secondCall = mockFetch.mock.calls[1]!;
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
      expect(result.alerts[0]!.event).toBe('Wind Advisory');
      expect(result.alerts[0]!.severity).toBe('Moderate');
      expect(result.alerts[0]!.ends).toBe('2026-04-03T18:00:00-07:00');
    });

    it('maps a null ends to null for open-ended hazards (regression: issue #18)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          features: [
            {
              properties: {
                id: 'urn:oid:open-ended',
                event: 'Flood Warning',
                headline: 'Flood Warning until further notice',
                description: 'Open-ended flooding.',
                instruction: null,
                severity: 'Severe',
                urgency: 'Expected',
                certainty: 'Likely',
                areaDesc: 'Chelan County',
                onset: '2026-06-21T11:00:00-07:00',
                ends: null,
                expires: '2026-06-27T12:00:00-07:00',
                senderName: 'NWS Pendleton OR',
                affectedZones: ['https://api.weather.gov/zones/forecast/WAZ027'],
              },
            },
          ],
        }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().searchAlerts({}, ctx);

      expect(result.alerts[0]!.ends).toBeNull();
      expect(result.alerts[0]!.onset).toBe('2026-06-21T11:00:00-07:00');
    });

    it('keeps each affected zone paired with its upstream type (regression: issue #31)', async () => {
      // The zone type lives in the /zones/{type}/{code} URL. Keeping only the
      // last segment flattened forecast, county, and fire zones into one
      // indistinguishable string[], so callers could not tell which codes chain
      // into nws_get_zone_forecast.
      mockFetch.mockResolvedValueOnce(jsonResponse(zoneTypedAlertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().searchAlerts({}, ctx);

      expect(result.alerts[0]!.affectedZones).toEqual([
        { code: 'WAZ558', type: 'forecast' },
        { code: 'WAZ507', type: 'forecast' },
      ]);
      expect(result.alerts[1]!.affectedZones).toEqual([{ code: 'WAC033', type: 'county' }]);
      expect(result.alerts[2]!.affectedZones).toEqual([
        { code: 'WAZ027', type: 'forecast' },
        { code: 'WAC007', type: 'county' },
        { code: 'WAZ690', type: 'fire' },
      ]);
    });

    it('reports an unrecognized zone URL shape as an unknown type rather than guessing', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          features: [
            {
              properties: {
                ...alertsResponse.features[0]!.properties,
                affectedZones: ['WAZ558'],
              },
            },
          ],
        }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().searchAlerts({}, ctx);

      expect(result.alerts[0]!.affectedZones).toEqual([{ code: 'WAZ558', type: 'unknown' }]);
    });

    it('maps the CAP lifecycle fields on an original issuance (issue #33)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(alertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().searchAlerts({}, ctx);

      expect(result.alerts[0]).toMatchObject({
        sent: '2026-04-03T06:00:00-07:00',
        effective: '2026-04-03T06:00:00-07:00',
        status: 'Actual',
        messageType: 'Alert',
        references: [],
      });
      // The hazard-timing fields keep their own meaning alongside the new ones.
      expect(result.alerts[0]!.onset).toBe('2026-04-03T12:00:00-07:00');
      expect(result.alerts[0]!.ends).toBe('2026-04-03T18:00:00-07:00');
      expect(result.alerts[0]!.expires).toBe('2026-04-04T00:00:00-07:00');
    });

    it('compacts prior-alert references on an Update message to identifier and sent (issue #33)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(updateAlertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().searchAlerts({}, ctx);

      expect(result.alerts[0]!.messageType).toBe('Update');
      expect(result.alerts[0]!.references).toEqual([
        {
          identifier: 'urn:oid:2.49.0.1.840.0.update.001.1',
          sent: '2026-08-12T21:54:00-06:00',
        },
        {
          identifier: 'urn:oid:2.49.0.1.840.0.update.000.1',
          sent: '2026-08-12T18:30:00-06:00',
        },
      ]);
      // The upstream @id and sender keys are deliberately not carried through.
      expect(JSON.stringify(result.alerts[0]!.references)).not.toContain('sender');
      expect(JSON.stringify(result.alerts[0]!.references)).not.toContain('@id');
    });

    it('treats an absent references array as no prior messages', async () => {
      const { references: _dropped, ...withoutReferences } = alertsResponse.features[0]!.properties;
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ features: [{ properties: withoutReferences }] }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().searchAlerts({}, ctx);

      expect(result.alerts[0]!.references).toEqual([]);
    });

    it('collapses byte-identical duplicate features on id, keeping the first occurrence (issue #36)', async () => {
      // `/alerts/active` repeats some alerts verbatim within one response. The
      // second copy carries no information, so passing it through inflates every
      // downstream count and makes a caller's own dedupe look like truncation.
      mockFetch.mockResolvedValueOnce(jsonResponse(duplicateAlertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().searchAlerts({}, ctx);

      expect(result.alerts.map((alert) => alert.id)).toEqual([
        'urn:oid:duplicated-air-quality',
        'urn:oid:distinct-wind-advisory',
      ]);
      // The surviving copy is the first occurrence, unmodified.
      expect(result.alerts[0]).toMatchObject({
        event: 'Air Quality Alert',
        areaDesc: 'Central Washington',
        sent: '2026-04-03T08:00:00-07:00',
      });
    });

    it('collapses duplicates before the event filter, so a matching alert is counted once (issue #36)', async () => {
      // Dedupe has to run on the raw feature array. Filtering first and dedupeing
      // after would leave the duplicate in play for any caller reading the count
      // off the filtered set.
      mockFetch.mockResolvedValueOnce(jsonResponse(duplicateAlertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().searchAlerts({ event: ['air quality'] }, ctx);

      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0]!.id).toBe('urn:oid:duplicated-air-quality');
    });

    it('sends region_type lowercased and region comma-joined upstream (issue #32)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(emptyAlertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      await service.getNwsService().searchAlerts({ region: ['GL', 'GM'] }, ctx);

      expect(String(mockFetch.mock.calls[0]![0])).toBe(
        'https://api.weather.gov/alerts/active?region=GL%2CGM',
      );

      mockFetch.mockResolvedValueOnce(jsonResponse(emptyAlertsResponse));
      await service.getNwsService().searchAlerts({ region_type: 'Marine' }, ctx);

      // NWS rejects "Marine" with its own enumeration error — only the lowercase
      // form is accepted upstream.
      expect(String(mockFetch.mock.calls[1]![0])).toBe(
        'https://api.weather.gov/alerts/active?region_type=marine',
      );
    });

    it('omits region and region_type from the query when they are not supplied', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(emptyAlertsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      await service.getNwsService().searchAlerts({ region: [], area: 'WA' }, ctx);

      const url = String(mockFetch.mock.calls[0]![0]);
      expect(url).not.toContain('region');
      expect(url).toContain('area=WA');
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

      const url = mockFetch.mock.calls[0]![0] as string;
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

    it('throws station_not_found (not no_observations) when a station ID does not exist', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 404))
        .mockResolvedValueOnce(jsonResponse({}, 404));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getObservation({ stationId: 'ZZZZ' }, ctx);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'station_not_found' },
      });
      await expect(result).rejects.toThrow("Station 'ZZZZ' not found");
      await expect(result).rejects.not.toMatchObject({ data: { reason: 'no_observations' } });
    });

    it('prefers station_not_found even when the observations 404 lands first (regression: issue #19)', async () => {
      // Reproduce the production race: the observations/latest 404 resolves before
      // the station-metadata 404. Promise.all let the observations leg win and
      // mask the missing station; Promise.allSettled + station-first priority must
      // still classify a nonexistent station as station_not_found.
      mockFetch.mockImplementation(async (url) => {
        if (String(url).endsWith('/observations/latest')) {
          return jsonResponse({}, 404); // settles immediately — would win a race
        }
        // Station-metadata leg settles later, so the observations 404 lands first.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse({}, 404);
      });

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getObservation({ stationId: 'ZZZZ' }, ctx);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'station_not_found' },
      });
      await expect(result).rejects.not.toMatchObject({ data: { reason: 'no_observations' } });
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

    it('throws no_observations (not station_not_found) when observations/latest returns 404 for a known station', async () => {
      // Station metadata succeeds; observations/latest 404 must surface reason: 'no_observations',
      // not reason: 'station_not_found'. Before the fix both legs shared stationNotFoundFactory.
      mockFetch
        .mockResolvedValueOnce(jsonResponse(stationInfoResponse))
        .mockResolvedValueOnce(jsonResponse({}, 404));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().getObservation({ stationId: 'KSEA' }, ctx);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'no_observations' },
      });
      // Crucially — must NOT be station_not_found
      await expect(result).rejects.not.toMatchObject({
        data: { reason: 'station_not_found' },
      });
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

    it('retries observationStationsUrl fetch on transient 500 before succeeding (coord path)', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse({}, 500)) // transient failure on stations fetch
        .mockResolvedValueOnce(jsonResponse(stationsResponse)) // retry succeeds
        .mockResolvedValueOnce(jsonResponse(observationResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service
        .getNwsService()
        .getObservation({ latitude: 47.6062, longitude: -122.3321 }, ctx);

      expect(result.observation.stationId).toBe('KBFI');
      // 4 fetch calls: points, stations (fail), stations (retry), observation
      expect(mockFetch).toHaveBeenCalledTimes(4);
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
      const result = await service.getNwsService().findStations(47.6062, -122.3321, ctx);

      expect(result.stations.length).toBeGreaterThan(0);
      expect(result.stations[0]!.stationId).toBeDefined();
      // Each station should have distance and bearing
      for (const s of result.stations) {
        expect(s.distance).toBeGreaterThanOrEqual(0);
        expect(s.bearing).toBeTruthy();
      }
    });

    it('returns every station upstream reported, un-truncated, so the tool can page it', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(pointsResponse))
        .mockResolvedValueOnce(jsonResponse(stationsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service.getNwsService().findStations(47.6062, -122.3321, ctx);

      // The service applies no limit — nws_find_stations windows this array with
      // paginateArray, which needs the complete set to offer a next page.
      expect(result.stations).toHaveLength(stationsResponse.features.length);
      const distances = result.stations.map((s) => s.distance);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
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
      await expect(result).rejects.toThrow(/HTTP 429/);
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

  describe('cancellation and upstream status classification', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Build the DOMException-shaped rejection `fetch` raises on an aborted signal. */
    function abortRejection(): Error {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      return error;
    }

    it('retries an upstream 500 and surfaces ServiceUnavailable once attempts are spent', async () => {
      mockFetch.mockImplementation(async () => jsonResponse({}, 500));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().searchAlerts({}, ctx);
      const assertion = expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it('fails fast on an upstream 501 instead of retrying a method NWS does not implement', async () => {
      mockFetch.mockImplementation(async () => jsonResponse({}, 501));

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().searchAlerts({}, ctx);
      const assertion = expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { retryable: false },
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('classifies a caller disconnect as RequestCancelled, not Timeout', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation(async () => {
        controller.abort();
        throw abortRejection();
      });

      const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });
      const result = service.getNwsService().searchAlerts({}, ctx);
      const assertion = expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('classifies a caller disconnect on a retry attempt as RequestCancelled', async () => {
      const controller = new AbortController();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500)).mockImplementation(async () => {
        controller.abort();
        throw abortRejection();
      });

      const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });
      const result = service.getNwsService().searchAlerts({}, ctx);
      const assertion = expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('classifies a caller disconnect during retry backoff as RequestCancelled', async () => {
      const controller = new AbortController();
      mockFetch.mockImplementation(async () => jsonResponse({}, 500));

      const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });
      const result = service.getNwsService().searchAlerts({}, ctx);
      const assertion = expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.RequestCancelled,
      });

      // Let the first attempt fail and arm the backoff sleep, then disconnect.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      controller.abort();

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('still classifies an upstream stall as Timeout when the caller is present', async () => {
      mockFetch.mockImplementation(async () => {
        const error = new Error('The operation timed out.');
        error.name = 'TimeoutError';
        throw error;
      });

      const ctx = createMockContext({ tenantId: 'test' });
      const result = service.getNwsService().searchAlerts({}, ctx);
      const assertion = expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.Timeout,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
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
