/**
 * @fileoverview Tests for the NWS API service layer.
 * @module tests/services/nws/nws-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGED_OUT_ALERT_ID,
  alertCountsResponse,
  alertsResponse,
  alertTypesResponse,
  ascendingReferencesAlertsResponse,
  CURRENT_ALERT_ID,
  capReference,
  currentAlertFeature,
  duplicateAlertsResponse,
  emptyAlertsResponse,
  forecastResponse,
  gridlessMarinePointsResponse,
  invalidAlertProblem,
  KEEPALIVE_ALERT_ID,
  keepaliveAlertFeature,
  landOnlyAlertCountsResponse,
  notFoundProblem,
  observationFeature,
  observationResponse,
  outOfBoundsPointProblem,
  pointsResponse,
  SUPERSEDED_ALERT_ID,
  stationInfoResponse,
  stationsResponse,
  supersededAlertFeature,
  unexpectedProblem,
  updateAlertsResponse,
  updateAlertWithReferences,
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
    // A request no test queued a response for fails loudly instead of reaching live NWS.
    mockFetch.mockImplementation(async (input) => {
      throw new Error(`Unmocked fetch: ${String(input)}`);
    });

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

    describe('references ordering (issue #56)', () => {
      /** Answer every /alerts/active request with `body`; any other URL stays unmocked. */
      function serveAlerts(body: unknown) {
        mockFetch.mockImplementation(async (input) => {
          const url = new URL(String(input));
          if (url.hostname === 'api.weather.gov' && url.pathname === '/alerts/active') {
            return jsonResponse(body);
          }
          throw new Error(`Unmocked fetch: ${url.href}`);
        });
      }

      async function referencesFor(references: ReturnType<typeof capReference>[]) {
        serveAlerts(updateAlertWithReferences(references));
        const ctx = createMockContext({ tenantId: 'test' });
        const result = await service.getNwsService().searchAlerts({}, ctx);
        return result.alerts[0]!.references;
      }

      it('sorts references that arrive oldest first to newest first', async () => {
        serveAlerts(ascendingReferencesAlertsResponse);

        const ctx = createMockContext({ tenantId: 'test' });
        const result = await service.getNwsService().searchAlerts({}, ctx);

        expect(result.alerts[0]!.references).toEqual([
          { identifier: 'urn:oid:2.49.0.1.840.0.asc.003.1', sent: '2026-10-16T01:08:00-05:00' },
          { identifier: 'urn:oid:2.49.0.1.840.0.asc.002.1', sent: '2026-10-16T00:33:00-05:00' },
          { identifier: 'urn:oid:2.49.0.1.840.0.asc.001.1', sent: '2026-10-16T00:15:00-05:00' },
        ]);
      });

      it('lists the sorted identifiers in that order on both surfaces of nws_search_alerts', async () => {
        serveAlerts(ascendingReferencesAlertsResponse);
        const { searchAlertsTool } = await import(
          '@/mcp-server/tools/definitions/search-alerts.tool.js'
        );

        const result = await runToolContract(searchAlertsTool, {});
        const text = result.content
          .filter((block) => block.type === 'text')
          .map((block) => (block as { text: string }).text)
          .join('\n');
        const supersedes = text.split('\n').filter((line) => line.startsWith('**Supersedes:**'));
        const expected = ['003', '002', '001'].map((n) => `urn:oid:2.49.0.1.840.0.asc.${n}.1`);

        expect(result.isError).toBeFalsy();
        expect(
          (
            result.structuredContent as { alerts: { references: { identifier: string }[] }[] }
          ).alerts[0]!.references.map((r) => r.identifier),
        ).toEqual(expected);
        // One Supersedes line, listing exactly these identifiers in this order.
        expect(supersedes).toHaveLength(1);
        expect(supersedes[0]!.match(/urn:oid:\S+/g)).toEqual(expected);
      });

      it('compares instants, not strings, across a DST change', async () => {
        // 01:30-04:00 is 05:30Z; 01:15-05:00 is 06:15Z, the later instant despite
        // its earlier wall-clock string.
        const references = await referencesFor([
          capReference('urn:oid:edt', '2026-11-01T01:30:00-04:00'),
          capReference('urn:oid:est', '2026-11-01T01:15:00-05:00'),
        ]);

        expect(references.map((r) => r.identifier)).toEqual(['urn:oid:est', 'urn:oid:edt']);
      });

      it('keeps upstream relative order for references sent at the same instant', async () => {
        // Each pair below is one instant; the second pair is written in two offsets,
        // so a string comparison would reorder it.
        const references = await referencesFor([
          capReference('urn:oid:older', '2026-10-15T23:43:00-05:00'),
          capReference('urn:oid:same-a', '2026-10-16T01:14:00-05:00'),
          capReference('urn:oid:same-b', '2026-10-16T01:14:00-05:00'),
          capReference('urn:oid:offset-a', '2026-10-16T00:00:00-05:00'),
          capReference('urn:oid:offset-b', '2026-10-16T05:00:00Z'),
        ]);

        expect(references.map((r) => r.identifier)).toEqual([
          'urn:oid:same-a',
          'urn:oid:same-b',
          'urn:oid:offset-a',
          'urn:oid:offset-b',
          'urn:oid:older',
        ]);
      });

      it('sorts a reference with an unparseable sent last, keeping its value verbatim', async () => {
        const references = await referencesFor([
          capReference('urn:oid:garbled', 'not-a-timestamp'),
          capReference('urn:oid:earlier', '2026-10-16T00:15:00-05:00'),
          capReference('urn:oid:blank', ''),
          capReference('urn:oid:later', '2026-10-16T01:08:00-05:00'),
        ]);

        expect(references).toEqual([
          { identifier: 'urn:oid:later', sent: '2026-10-16T01:08:00-05:00' },
          { identifier: 'urn:oid:earlier', sent: '2026-10-16T00:15:00-05:00' },
          { identifier: 'urn:oid:garbled', sent: 'not-a-timestamp' },
          { identifier: 'urn:oid:blank', sent: '' },
        ]);
      });
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

    describe('a point outside NWS coverage (issue #58)', () => {
      /** Answer every /alerts/active request with one 400 body; any other URL stays unmocked. */
      function rejectAlerts(body: unknown) {
        mockFetch.mockImplementation(async (input) => {
          const url = new URL(String(input));
          if (url.hostname === 'api.weather.gov' && url.pathname === '/alerts/active') {
            return jsonResponse(body, 400);
          }
          throw new Error(`Unmocked fetch: ${url.href}`);
        });
      }

      it('raises the out-of-bounds point 400 as invalid_point, naming the point, with one request', async () => {
        rejectAlerts(outOfBoundsPointProblem);

        const ctx = createMockContext({ tenantId: 'test' });
        const error = await service
          .getNwsService()
          .searchAlerts({ point: '10,10' }, ctx)
          .catch((e: unknown) => e);

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_point', status: 400 },
        });
        expect((error as Error).message).toBe(
          'Point "10,10" is outside NWS coverage (NWS: Parameter "point" is invalid: out of bounds).',
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      it('keeps a 400 InvalidParameter naming another parameter reason-less and verbatim', async () => {
        rejectAlerts({
          ...outOfBoundsPointProblem,
          detail: 'Parameter "status" is invalid: unknown value',
        });

        const ctx = createMockContext({ tenantId: 'test' });
        const error = await service
          .getNwsService()
          .searchAlerts({ point: '47.6,-122.3' }, ctx)
          .catch((e: unknown) => e);

        expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
        expect((error as { data?: { reason?: unknown } }).data?.reason).toBeUndefined();
        expect((error as Error).message).toBe('Parameter "status" is invalid: unknown value');
      });

      it('keeps a 400 of another problem type reason-less on a point search', async () => {
        rejectAlerts({
          ...outOfBoundsPointProblem,
          type: 'https://api.weather.gov/problems/BadRequest',
        });

        const ctx = createMockContext({ tenantId: 'test' });
        const error = await service
          .getNwsService()
          .searchAlerts({ point: '10,10' }, ctx)
          .catch((e: unknown) => e);

        expect(error).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
        expect((error as { data?: { reason?: unknown } }).data?.reason).toBeUndefined();
        expect((error as Error).message).toBe('Parameter "point" is invalid: out of bounds');
      });
    });
  });

  describe('getAlert', () => {
    const requestedUrls = () => mockFetch.mock.calls.map(([input]) => String(input));

    it('requests /alerts/{id} once and parses the Feature like a search result', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(currentAlertFeature));

      const ctx = createMockContext({ tenantId: 'test' });
      const alert = await service.getNwsService().getAlert(CURRENT_ALERT_ID, ctx);

      expect(requestedUrls()).toEqual([`https://api.weather.gov/alerts/${CURRENT_ALERT_ID}`]);
      const { properties } = currentAlertFeature;
      expect(alert).toEqual({
        id: CURRENT_ALERT_ID,
        event: 'Freeze Warning',
        headline: properties.headline,
        description: properties.description,
        instruction: properties.instruction,
        severity: 'Severe',
        urgency: 'Expected',
        certainty: 'Likely',
        areaDesc: 'Divide; Burke; Renville',
        sent: '2026-10-16T07:15:00-05:00',
        effective: '2026-10-16T07:15:00-05:00',
        onset: '2026-10-16T07:15:00-05:00',
        ends: '2026-10-16T10:00:00-05:00',
        expires: '2026-10-16T10:00:00-05:00',
        status: 'Actual',
        messageType: 'Update',
        // Upstream listed these oldest first; the shared parser puts the immediate
        // predecessor first and compacts each entry to identifier + sent.
        references: [
          { identifier: SUPERSEDED_ALERT_ID, sent: '2026-10-16T01:14:00-05:00' },
          {
            identifier: 'urn:oid:2.49.0.1.840.0.478df6166ade7585f4aed605340188fa5f655ff1.001.2',
            sent: '2026-10-15T23:43:00-05:00',
          },
          {
            identifier: 'urn:oid:2.49.0.1.840.0.478df6166ade7585f4aed605340188fa5f655ff1.002.1',
            sent: '2026-10-15T23:43:00-05:00',
          },
        ],
        senderName: 'NWS Bismarck ND',
        affectedZones: [
          { code: 'NDZ001', type: 'forecast' },
          { code: 'NDZ002', type: 'forecast' },
          { code: 'NDZ003', type: 'forecast' },
        ],
      });
    });

    it('returns the same fields a search returns for the same Feature', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(currentAlertFeature))
        .mockResolvedValueOnce(jsonResponse({ features: [currentAlertFeature] }));

      const ctx = createMockContext({ tenantId: 'test' });
      const fetched = await service.getNwsService().getAlert(CURRENT_ALERT_ID, ctx);
      const searched = await service.getNwsService().searchAlerts({}, ctx);

      expect(fetched).toEqual(searched.alerts[0]);
    });

    it('fetches a superseded message with its own lifecycle and references', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(supersededAlertFeature));

      const ctx = createMockContext({ tenantId: 'test' });
      const alert = await service.getNwsService().getAlert(SUPERSEDED_ALERT_ID, ctx);

      expect(alert.id).toBe(SUPERSEDED_ALERT_ID);
      expect(alert.messageType).toBe('Update');
      expect(alert.sent).toBe('2026-10-16T01:14:00-05:00');
      expect(alert.references.map((r) => r.identifier)).toEqual([
        'urn:oid:2.49.0.1.840.0.478df6166ade7585f4aed605340188fa5f655ff1.001.2',
        'urn:oid:2.49.0.1.840.0.478df6166ade7585f4aed605340188fa5f655ff1.002.1',
      ]);
      // replacedBy/replacedAt are not part of the alert shape the two tools share.
      expect(alert).not.toHaveProperty('replacedBy');
    });

    it('accepts the KEEPALIVE heartbeat ID and keeps its null fields null', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(keepaliveAlertFeature));

      const ctx = createMockContext({ tenantId: 'test' });
      const alert = await service.getNwsService().getAlert(KEEPALIVE_ALERT_ID, ctx);

      expect(requestedUrls()).toEqual([`https://api.weather.gov/alerts/${KEEPALIVE_ALERT_ID}`]);
      expect(alert).toMatchObject({
        status: 'Test',
        headline: null,
        onset: null,
        ends: null,
        references: [],
        affectedZones: [{ code: 'MDC031', type: 'county' }],
      });
    });

    it('requests an ID with surrounding whitespace trimmed', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(currentAlertFeature));

      const ctx = createMockContext({ tenantId: 'test' });
      await service.getNwsService().getAlert(` \n${CURRENT_ALERT_ID}\t `, ctx);

      expect(requestedUrls()).toEqual([`https://api.weather.gov/alerts/${CURRENT_ALERT_ID}`]);
    });

    it('maps the 404 InvalidAlert problem to alert_not_found without retrying', async () => {
      mockFetch.mockResolvedValue(jsonResponse(invalidAlertProblem, 404));

      const ctx = createMockContext({ tenantId: 'test' });
      const error = await service
        .getNwsService()
        .getAlert(AGED_OUT_ALERT_ID, ctx)
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'alert_not_found', alertId: AGED_OUT_ALERT_ID },
      });
      expect((error as Error).message).toBe(
        `NWS has no alert "${AGED_OUT_ALERT_ID}": the ID does not exist, or the message is past the ~7 days NWS keeps alerts.`,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps an exhausted 500 a retryable outage, not alert_not_found', async () => {
      const origSetTimeout = globalThis.setTimeout;
      vi.stubGlobal('setTimeout', (fn: () => void) => origSetTimeout(fn, 0));
      mockFetch.mockImplementation(async () => jsonResponse(unexpectedProblem, 500));

      const ctx = createMockContext({ tenantId: 'test' });
      const error = await service
        .getNwsService()
        .getAlert(CURRENT_ALERT_ID, ctx)
        .catch((e: unknown) => e)
        .finally(() => vi.stubGlobal('setTimeout', origSetTimeout));

      expect(error).toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect((error as { data?: { reason?: unknown } }).data?.reason).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
      ['traversal', '../alerts/active'],
      ['traversal suffix', `${CURRENT_ALERT_ID}/../active`],
      ['URL form', `https://api.weather.gov/alerts/${CURRENT_ALERT_ID}`],
      ['uppercased', CURRENT_ALERT_ID.toUpperCase()],
      ['uppercase prefix', CURRENT_ALERT_ID.replace('urn:oid:', 'URN:OID:')],
      ['uppercase hex', CURRENT_ALERT_ID.replace('654087301e', '654087301E')],
      ['short hash', CURRENT_ALERT_ID.replace('654087301e', '654087301')],
      ['missing version', CURRENT_ALERT_ID.replace(/\.1$/, '')],
      ['trailing dot', `${CURRENT_ALERT_ID}.`],
      ['percent-encoded', CURRENT_ALERT_ID.replaceAll(':', '%3A')],
      ['inner whitespace', CURRENT_ALERT_ID.replace('.001.', '. 001.')],
      ['lowercase keepalive', KEEPALIVE_ALERT_ID.toLowerCase()],
      ['foreign OID root', CURRENT_ALERT_ID.replace('2.49.0.1.840.0', '2.49.0.1.124.0')],
    ])('rejects a malformed ID (%s) as alert_not_found with no request', async (_label, id) => {
      const ctx = createMockContext({ tenantId: 'test' });
      const error = await service
        .getNwsService()
        .getAlert(id, ctx)
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'alert_not_found' },
      });
      expect((error as Error).message).toBe(
        'alert_id is not an NWS alert ID. NWS alert IDs read "urn:oid:2.49.0.1.840.0." followed by a 40-character lowercase hex hash, a 3-digit segment, and a version (e.g., "urn:oid:2.49.0.1.840.0.654087301e4bfcbe71d24494c26a965e54d3a1ad.001.1").',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('accepts every ID shape the shared pattern documents', () => {
      expect(service.ALERT_ID_PATTERN.test(CURRENT_ALERT_ID)).toBe(true);
      expect(service.ALERT_ID_PATTERN.test(SUPERSEDED_ALERT_ID)).toBe(true);
      expect(service.ALERT_ID_PATTERN.test(KEEPALIVE_ALERT_ID)).toBe(true);
      // Multi-digit segment versions occur upstream (versions .1–.3 observed).
      expect(service.ALERT_ID_PATTERN.test(CURRENT_ALERT_ID.replace(/\.1$/, '.12'))).toBe(true);
      expect(service.ALERT_ID_PATTERN.flags).toBe('');
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

    it('returns no stations for a gridless marine point, and caches the point (issue #38)', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(gridlessMarinePointsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const first = await service.getNwsService().findStations(28, -90, ctx);
      const second = await service.getNwsService().findStations(28, -90, ctx);

      expect(first.stations).toEqual([]);
      expect(second.stations).toEqual([]);
      // One /points request: no station list to follow, and the answer is cached.
      expect(mockFetch).toHaveBeenCalledTimes(1);
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

  describe('getAlertCounts', () => {
    it('requests the count endpoint with no query string and drops the zones map', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(alertCountsResponse));

      const ctx = createMockContext({ tenantId: 'test' });
      const counts = await service.getNwsService().getAlertCounts(ctx);

      expect(String(mockFetch.mock.calls[0]![0])).toBe(
        'https://api.weather.gov/alerts/active/count',
      );
      expect(counts).toEqual({
        total: 224,
        land: 124,
        marine: 100,
        areas: alertCountsResponse.areas,
        regions: alertCountsResponse.regions,
      });
      expect(counts).not.toHaveProperty('zones');
    });

    it.each([
      ['an empty object', {}],
      ['a bare array', []],
      ['absent', undefined],
    ])('reads a regions map sent as %s as empty', async (_label, regions) => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ...landOnlyAlertCountsResponse, regions }));

      const ctx = createMockContext({ tenantId: 'test' });
      const counts = await service.getNwsService().getAlertCounts(ctx);

      expect(counts.regions).toEqual({});
      expect(counts.areas).toEqual({ OK: 2, KS: 1 });
    });
  });

  describe('getObservationHistory', () => {
    const stationUrl = 'https://api.weather.gov/stations/KSEA';

    it('fetches the station record and the observation list, mapping each feature', async () => {
      mockFetch.mockImplementation(async (input) =>
        String(input) === stationUrl
          ? jsonResponse(stationInfoResponse)
          : jsonResponse({
              features: [
                observationFeature('2026-09-30T10:20:00+00:00'),
                observationFeature('2026-09-30T10:15:00+00:00', { temperature: undefined }),
              ],
            }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      const result = await service
        .getNwsService()
        .getObservationHistory({ stationId: 'ksea', limit: 2 }, ctx);

      expect(result.stationId).toBe('KSEA');
      expect(result.stationName).toBe('Seattle, Seattle-Tacoma International Airport');
      expect(result.timeZone).toBe('America/Los_Angeles');
      expect(result.observations.map((o) => o.timestamp)).toEqual([
        '2026-09-30T10:20:00+00:00',
        '2026-09-30T10:15:00+00:00',
      ]);
      expect(result.observations[0]!.stationId).toBe('KSEA');
      // An omitted measurement stays null, never 0.
      expect(result.observations[1]!.temperature.value).toBeNull();
    });

    it('sends limit, start, and end upstream, encoding the offset sign', async () => {
      mockFetch.mockImplementation(async (input) =>
        String(input) === stationUrl
          ? jsonResponse(stationInfoResponse)
          : jsonResponse({ features: [] }),
      );

      const ctx = createMockContext({ tenantId: 'test' });
      await service.getNwsService().getObservationHistory(
        {
          stationId: 'KSEA',
          limit: 5,
          start: '2026-09-29T17:00:00-07:00',
          end: '2026-09-30T12:00:00+00:00',
        },
        ctx,
      );

      const listUrl = new URL(
        mockFetch.mock.calls.map(([input]) => String(input)).find((u) => u !== stationUrl)!,
      );
      expect(listUrl.pathname).toBe('/stations/KSEA/observations');
      expect(Object.fromEntries(listUrl.searchParams)).toEqual({
        limit: '5',
        start: '2026-09-29T17:00:00-07:00',
        end: '2026-09-30T12:00:00+00:00',
      });
      expect(listUrl.search).toContain('end=2026-09-30T12%3A00%3A00%2B00%3A00');
    });

    it('rejects a non-alphanumeric station ID as station_not_found without a request', async () => {
      const ctx = createMockContext({ tenantId: 'test' });
      const result = service
        .getNwsService()
        .getObservationHistory({ stationId: '../KSEA', limit: 5 }, ctx);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'station_not_found', stationId: '../KSEA' },
      });
      expect(mockFetch).not.toHaveBeenCalled();
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

  /**
   * Each patterned input runs through the real tool and this service over a fetch that
   * answers 404 to everything, so the first request a raw value produces is the one
   * the handler and service build from it today.
   */
  describe('advertised input patterns (issue #54)', () => {
    type Tools = typeof import('@/mcp-server/tools/definitions/index.js');
    type Definition = Tools[keyof Tools];
    let tools: Tools;
    let origSetTimeout: typeof globalThis.setTimeout;

    beforeEach(async () => {
      tools = await import('@/mcp-server/tools/definitions/index.js');
      mockFetch.mockImplementation(async () => jsonResponse(notFoundProblem, 404));
      // Retry backoff, if any, runs immediately.
      origSetTimeout = globalThis.setTimeout;
      vi.stubGlobal('setTimeout', (fn: () => void) => origSetTimeout(fn, 0));
    });

    afterEach(() => {
      vi.stubGlobal('setTimeout', origSetTimeout);
    });

    /** The pattern a client reads from the definition's advertised input schema. */
    function advertised(definition: Definition, field: string): RegExp {
      const schema = z.toJSONSchema(definition.input, { io: 'input' }) as {
        properties: Record<string, { pattern?: string }>;
      };
      const source = schema.properties[field]?.pattern;
      expect(source, `${definition.name}.${field}`).toBeTypeOf('string');
      return new RegExp(source as string, 'u');
    }

    /** URLs requested while the tool runs on `args`. */
    async function requested(definition: Definition, args: Record<string, unknown>) {
      const before = mockFetch.mock.calls.length;
      await runToolContract(definition as never, args as never);
      return mockFetch.mock.calls.slice(before).map(([input]) => new URL(String(input)));
    }

    /**
     * `path` is a path some request hits exactly; `param`, for a query-string field,
     * is the one value every request sends for it.
     */
    it.each([
      ['searchAlertsTool', 'area', 'wa', '/alerts/active', 'WA'],
      ['searchAlertsTool', 'area', ' WA ', '/alerts/active', 'WA'],
      ['searchAlertsTool', 'point', '47.6,-122.3', '/alerts/active', '47.6,-122.3'],
      ['searchAlertsTool', 'point', ' 47.6 , -122.3 ', '/alerts/active', '47.6,-122.3'],
      ['searchAlertsTool', 'point', '4 7.6,-122.3', '/alerts/active', '47.6,-122.3'],
      ['searchAlertsTool', 'zone', 'waz315', '/alerts/active', 'WAZ315'],
      ['searchAlertsTool', 'zone', ' WAZ315 ', '/alerts/active', 'WAZ315'],
      ['searchAlertsTool', 'zone', 'wac033', '/alerts/active', 'WAC033'],
      ['getObservationsTool', 'station_id', 'ksea', '/stations/KSEA'],
      ['getObservationsTool', 'station_id', ' KSEA ', '/stations/KSEA'],
      ['getObservationsTool', 'station_id', '000PG', '/stations/000PG'],
      ['getObservationsTool', 'station_id', '0007W', '/stations/0007W'],
      ['getObservationsTool', 'station_id', 'NTC1612401', '/stations/NTC1612401'],
      ['getObservationHistoryTool', 'station_id', ' ksea ', '/stations/KSEA'],
      ['getObservationHistoryTool', 'station_id', 'NTC1612401', '/stations/NTC1612401'],
      [
        'getObservationHistoryTool',
        'start',
        '2026-10-15T05:00:00-07:00',
        '/stations/KSEA/observations',
        '2026-10-15T05:00:00-07:00',
      ],
      [
        'getObservationHistoryTool',
        'start',
        '2026-10-15T12:00:00.123456Z',
        '/stations/KSEA/observations',
        '2026-10-15T12:00:00.123456Z',
      ],
      [
        'getObservationHistoryTool',
        'start',
        ' 2026-10-15T12:00:00Z ',
        '/stations/KSEA/observations',
        '2026-10-15T12:00:00Z',
      ],
      [
        'getObservationHistoryTool',
        'end',
        '2026-10-16T12:00:00Z',
        '/stations/KSEA/observations',
        '2026-10-16T12:00:00Z',
      ],
      ['getOfficeDiscussionTool', 'office', 'sew', '/products/types/AFD/locations/SEW'],
      ['getOfficeDiscussionTool', 'office', ' SEW ', '/products/types/AFD/locations/SEW'],
      ['getZoneForecastTool', 'zone_id', 'waz315', '/zones/forecast/WAZ315/forecast'],
      ['getZoneForecastTool', 'zone_id', ' WAZ315 ', '/zones/forecast/WAZ315/forecast'],
      ['getAlertTool', 'alert_id', ` ${CURRENT_ALERT_ID} `, `/alerts/${CURRENT_ALERT_ID}`],
    ] as const)(
      '%s %s %j matches its pattern and requests %s',
      async (name, field, value, path, param?: string) => {
        const definition = tools[name] as Definition;
        expect(advertised(definition, field).test(value)).toBe(true);

        const args = {
          ...(name === 'getObservationHistoryTool' && field !== 'station_id'
            ? { station_id: 'KSEA' }
            : {}),
          [field]: value,
        };
        const urls = await requested(definition, args);

        expect(urls.map((url) => url.pathname)).toContain(path);
        if (param !== undefined) {
          expect(urls.flatMap((url) => url.searchParams.getAll(field))).toEqual([param]);
        }
      },
    );

    it.each([
      ['ZFP', 'PR'],
      ['SPS', 'pq1'],
    ])('admits the 2–3 character %s location %j and requests it', async (productType, office) => {
      const definition = tools.getOfficeDiscussionTool;
      expect(advertised(definition, 'office').test(office)).toBe(true);

      const urls = await requested(definition, { office, product_type: productType });

      expect(urls[0]?.pathname).toBe(
        `/products/types/${productType}/locations/${office.toUpperCase()}`,
      );
    });

    it.each([
      ['searchAlertsTool', 'area'],
      ['searchAlertsTool', 'point'],
      ['searchAlertsTool', 'zone'],
      ['getObservationHistoryTool', 'start'],
      ['getObservationHistoryTool', 'end'],
    ] as const)('%s admits a blank %s, which the request leaves off', async (name, field) => {
      const definition = tools[name] as Definition;
      for (const blank of ['', '   ']) {
        expect(advertised(definition, field).test(blank)).toBe(true);
        const args = {
          ...(name === 'getObservationHistoryTool' ? { station_id: 'KSEA' } : {}),
          [field]: blank,
        };
        const urls = await requested(definition, args);
        expect(urls.length).toBeGreaterThan(0);
        expect(urls.every((url) => !url.searchParams.has(field))).toBe(true);
      }
    });

    it('resolves a blank station_id from coordinates, which its pattern admits', async () => {
      const definition = tools.getObservationsTool;
      for (const blank of ['', '  ']) {
        expect(advertised(definition, 'station_id').test(blank)).toBe(true);
        const urls = await requested(definition, {
          station_id: blank,
          latitude: 47.6062,
          longitude: -122.3321,
        });
        expect(urls[0]?.pathname).toBe('/points/47.6062,-122.3321');
      }
    });

    /**
     * Seeded fuzz over random strings from each field's alphabet and edits of valid
     * seeds. A raw value that reaches fetch passed every lexical check the tool and
     * service make, so the field's pattern must admit it, or a validating client would
     * refuse a value the server serves. office and zone_id are the exception: the
     * service sends any alphanumeric code upstream, and their patterns narrow it to
     * the shapes NWS serves (every product location is 2–3 characters, and only
     * Z-infix zones carry a zone forecast), so for those two the check runs the
     * other way — nothing the pattern admits is refused before a request.
     */
    it('agrees with the lexical checks on every fuzzed value', async () => {
      let state = 54;
      const random = () => {
        state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
        return state / 2 ** 32;
      };
      const pick = (chars: string) => chars[Math.floor(random() * chars.length)] as string;
      const randomString = (chars: string, maxLength: number) =>
        Array.from({ length: Math.floor(random() * (maxLength + 1)) }, () => pick(chars)).join('');
      const edit = (seed: string, chars: string) => {
        let value = seed;
        for (let n = 1 + Math.floor(random() * 3); n > 0; n--) {
          const at = Math.floor(random() * (value.length + 1));
          const op = Math.floor(random() * 4);
          if (op === 0) value = value.slice(0, at) + pick(chars) + value.slice(at);
          else if (op === 1) value = value.slice(0, at) + value.slice(at + 1);
          else if (op === 2) value = value.slice(0, at) + pick(chars) + value.slice(at + 1);
          else value = `${pick(' \t')}${value}${pick(' \t')}`;
        }
        return value;
      };

      const fields = [
        { name: 'searchAlertsTool', field: 'area', chars: 'waWAgmGMqQ1 \t-', seeds: ['WA', 'gm'] },
        {
          name: 'searchAlertsTool',
          field: 'point',
          chars: '0123456789.,-+ \t',
          seeds: ['47.6,-122.3', '-14.3,-170.7', '47,-122'],
        },
        {
          name: 'searchAlertsTool',
          field: 'zone',
          chars: 'waWAzZcCqQ0123456789 \t-',
          seeds: ['WAZ315', 'pzc135'],
        },
        {
          name: 'getObservationsTool',
          field: 'station_id',
          chars: 'kseaKSEA0179 \t-_./%',
          seeds: ['KSEA', '000PG'],
        },
        {
          name: 'getObservationHistoryTool',
          field: 'station_id',
          chars: 'kseaKSEA0179 \t-_./%',
          seeds: ['KSEA', 'NTC1612401'],
        },
        {
          name: 'getObservationHistoryTool',
          field: 'start',
          base: { station_id: 'KSEA' },
          chars: '0123456789-:TtZz.+ ',
          seeds: ['2026-10-15T12:00:00Z', '2026-10-15T05:00:00.123456-07:00'],
        },
        {
          name: 'getObservationHistoryTool',
          field: 'end',
          base: { station_id: 'KSEA' },
          chars: '0123456789-:TtZz.+ ',
          seeds: ['2026-10-16T12:00:00Z', '2026-10-16T05:00:00+05:30'],
        },
        {
          name: 'getOfficeDiscussionTool',
          field: 'office',
          chars: 'sewSEWpqPQ1 \t-./',
          seeds: ['SEW', 'pq1', 'PR'],
          upstreamNarrowed: true,
        },
        {
          name: 'getZoneForecastTool',
          field: 'zone_id',
          chars: 'waWAzZcC0123456789 \t-',
          seeds: ['WAZ315', 'pzz135'],
          upstreamNarrowed: true,
        },
        {
          name: 'getAlertTool',
          field: 'alert_id',
          chars: '0123456789abcdefABCDEF.:-urnoidKEPALIV \t/',
          seeds: [CURRENT_ALERT_ID, KEEPALIVE_ALERT_ID],
          noRandom: true,
        },
      ] as const;

      const disagreements: string[] = [];
      for (const spec of fields) {
        const definition = tools[spec.name] as Definition;
        const label = `${definition.name}.${spec.field}`;
        const pattern = advertised(definition, spec.field);
        const values: string[] = [...spec.seeds];
        for (let i = 0; i < 1000; i++) {
          const seed = spec.seeds[Math.floor(random() * spec.seeds.length)] as string;
          values.push(edit(seed, spec.chars));
          if (!('noRandom' in spec)) values.push(randomString(spec.chars, 14));
        }

        let reached = 0;
        let refused = 0;
        for (const value of values) {
          const base = 'base' in spec ? spec.base : {};
          const urls = await requested(definition, { ...base, [spec.field]: value });
          const admitted = pattern.test(value);
          if (urls.length > 0) reached++;
          else refused++;
          const disagrees =
            'upstreamNarrowed' in spec
              ? admitted && urls.length === 0
              : !admitted && urls.length > 0;
          if (disagrees) disagreements.push(`${label} ${JSON.stringify(value)}`);
        }
        // Both outcomes occur, so the fuzz exercises the checks rather than one branch.
        expect(reached, `${label} reached`).toBeGreaterThan(20);
        expect(refused, `${label} refused`).toBeGreaterThan(20);
      }

      expect(disagreements).toEqual([]);
    });

    /**
     * Clients compile these patterns over caller text, most with a backtracking engine.
     * Two `\s*` that can both match one whitespace run (`^\s*(?:X)?\s*$` with X absent)
     * backtrack quadratically on a long run that ends in a refused character, so each
     * pattern keeps its whitespace runs unambiguous. Each shape is timed in thread CPU
     * at both ends of a 64× span, with equal total characters at each end (64 calls on
     * the short text, 1 on the long), so a linear pattern costs about the same at
     * both ends and a quadratic one 64× more. The long side doubles up to the span and
     * stops at the first length past the absolute bound, so a quadratic pattern fails
     * within its first doublings instead of backtracking through the whole span.
     * Shapes built on digit runs stop at 40k characters: from about 80k, Bun's engine
     * (JavaScriptCore) moves a long run of nested-quantifier matches onto a slower
     * path, a constant-factor step that is not growth.
     */
    it('keeps every advertised pattern linear on adversarial input', () => {
      const cpuMs = () => {
        const { user, system } = process.threadCpuUsage();
        return (user + system) / 1000;
      };
      /** Least thread CPU of three runs of `calls` matches of `text`. */
      const cost = (pattern: RegExp, text: string, calls: number) => {
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 3; run++) {
          const start = cpuMs();
          for (let i = 0; i < calls; i++) pattern.test(text);
          best = Math.min(best, cpuMs() - start);
        }
        return best;
      };
      const shapes = [
        { name: 'whitespace run', short: 5_000, build: (n: number) => `${' '.repeat(n)}!` },
        {
          name: 'value then whitespace run',
          short: 5_000,
          build: (n: number) => `1,1${' '.repeat(n)}!`,
        },
        {
          name: 'letters then whitespace run',
          short: 5_000,
          build: (n: number) => `${'a'.repeat(n / 2)}${' '.repeat(n / 2)}!`,
        },
        { name: 'digit run', short: 625, build: (n: number) => `${'1'.repeat(n)}!` },
        { name: 'spaced digits', short: 625, build: (n: number) => `${'1 '.repeat(n / 2)}!` },
      ];
      const patterned = [
        ['searchAlertsTool', 'area'],
        ['searchAlertsTool', 'point'],
        ['searchAlertsTool', 'zone'],
        ['getObservationsTool', 'station_id'],
        ['getObservationHistoryTool', 'station_id'],
        ['getObservationHistoryTool', 'start'],
        ['getOfficeDiscussionTool', 'office'],
        ['getZoneForecastTool', 'zone_id'],
        ['getAlertTool', 'alert_id'],
      ] as const;

      const slow: string[] = [];
      for (const [name, field] of patterned) {
        const pattern = advertised(tools[name] as Definition, field);
        for (const shape of shapes) {
          const span = shape.short * 64;
          const shortText = shape.build(shape.short);
          // A pattern is slow only when every one of three measurements says so, so a
          // GC pause or scheduler stall inside one measurement does not fail the run;
          // a quadratic pattern is slow on all three.
          let verdict = '';
          for (let attempt = 0; attempt < 3; attempt++) {
            verdict = '';
            const shortTotal = cost(pattern, shortText, 64);
            for (let length = shape.short * 2; length <= span; length *= 2) {
              const longCall = cost(pattern, shape.build(length), 1);
              if (longCall >= 50) {
                verdict = `${name}.${field} on ${shape.name}: ${longCall.toFixed(2)} ms at ${length}`;
                break;
              }
              if (length < span) continue;
              // Per-call cost ratio across the span; a 50µs floor under the short side
              // keeps timer noise on near-instant refusals from reading as growth.
              const ratio = (longCall / Math.max(shortTotal, 0.05)) * 64;
              if (ratio >= 256) {
                verdict = `${name}.${field} on ${shape.name}: ratio ${ratio.toFixed(0)} at ${span}`;
              }
            }
            if (!verdict) break;
          }
          if (verdict) slow.push(verdict);
        }
      }

      expect(slow).toEqual([]);
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
