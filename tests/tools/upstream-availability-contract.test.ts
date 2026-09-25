/**
 * @fileoverview Wire-contract tests for how upstream availability failures reach
 * callers: marine forecast refusals (issue #38) and valid zones with no text
 * forecast (issue #40). Each case runs the real tool definition and the real NWS
 * service through `runToolContract` over a strict fetch fake, so the 404
 * problem-type read, the retry loop, the zone-record probe, and the error
 * envelope are all exercised — nothing below the tool is mocked.
 * @module tests/tools/upstream-availability-contract
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forecastResponse,
  griddedMarinePointsResponse,
  gridlessMarinePointsResponse,
  invalidGridpointProblem,
  invalidPointProblem,
  invalidZoneProblem,
  marineForecastNotSupportedProblem,
  notFoundProblem,
  observationResponse,
  pointsResponse,
  stationInfoResponse,
  stationsResponse,
  unexpectedProblem,
  zoneForecastResponse,
  zoneRecordResponse,
} from '../fixtures/nws-responses.js';

const API = 'https://api.weather.gov';
const MARINE_GRID = `${API}/gridpoints/PQR/74,145`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/geo+json' },
  });
}

/** Every route answers each request with a fresh Response built from the body. */
function route(match: string, body: unknown, status = 200) {
  return { match, respond: () => json(body, status) };
}

type Tools = typeof import('@/mcp-server/tools/definitions/index.js');
type ErrorEnvelope = {
  code: number;
  data?: { reason?: string; recovery?: { hint?: string }; [key: string]: unknown };
  message: string;
};

/** The error envelope from `structuredContent.error`, plus every text block joined. */
function errorOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error: ErrorEnvelope }).error;
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n');
  return { error, text };
}

/** Text of every content block of a success result. */
function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  expect(result.isError).toBeFalsy();
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n');
}

function contractRecovery(
  definition: { errors?: readonly { reason: string; recovery: string }[] },
  reason: string,
): string | undefined {
  return definition.errors?.find((entry) => entry.reason === reason)?.recovery;
}

describe('upstream availability contract', () => {
  let tools: Tools;
  let http: FetchMockHarness;
  /** Backoff delays `withRetry` asked for, in order — the retry budget as observed. */
  let backoffDelays: number[];
  let origSetTimeout: typeof globalThis.setTimeout;

  beforeEach(async () => {
    // Fresh module graph per test: the service's /points cache is module state.
    vi.resetModules();
    const service = await import('@/services/nws/nws-service.js');
    service.initNwsService();
    tools = await import('@/mcp-server/tools/definitions/index.js');

    // Strict: an unrouted URL rejects, so no test can reach live NWS.
    http = createFetchMock();
    http.install();

    backoffDelays = [];
    origSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms >= 1000) backoffDelays.push(ms);
      return origSetTimeout(fn, 0);
    }) as typeof setTimeout);
  });

  afterEach(() => {
    http.restore();
    vi.stubGlobal('setTimeout', origSetTimeout);
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // #38 — marine forecasts
  // -------------------------------------------------------------------------

  describe('nws_get_forecast on marine coordinates', () => {
    it.each([
      { hourly: false, url: `${MARINE_GRID}/forecast` },
      { hourly: true, url: `${MARINE_GRID}/forecast/hourly` },
    ])(
      'turns a gridpoint MarineForecastNotSupported (hourly=$hourly) into marine_forecast_unsupported',
      async ({ hourly, url }) => {
        http.route(
          route(`${API}/points/46.2,-124.1`, griddedMarinePointsResponse),
          route(url, marineForecastNotSupportedProblem, 404),
        );

        const result = await runToolContract(tools.getForecastTool, {
          latitude: 46.2,
          longitude: -124.1,
          hourly,
        });
        const { error, text } = errorOf(result);
        const hint = contractRecovery(tools.getForecastTool, 'marine_forecast_unsupported');

        expect(error.code).toBe(JsonRpcErrorCode.NotFound);
        expect(error.data?.reason).toBe('marine_forecast_unsupported');
        expect(hint).toBeDefined();
        expect(error.data?.recovery?.hint).toBe(hint);
        expect(error.message).toContain('PZZ251');
        expect(text).toContain(`Recovery: ${hint}`);
        expect(text).toContain('reason marine_forecast_unsupported');
        expect(http.calls.map((c) => c.request.url)).toEqual([`${API}/points/46.2,-124.1`, url]);
      },
    );

    it('fails a gridless marine point with marine_forecast_unsupported after one upstream call', async () => {
      http.route(route(`${API}/points/28,-90`, gridlessMarinePointsResponse));

      const result = await runToolContract(tools.getForecastTool, {
        latitude: 28,
        longitude: -90,
      });
      const { error, text } = errorOf(result);

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('marine_forecast_unsupported');
      expect(error.data?.recovery?.hint).toBe(
        contractRecovery(tools.getForecastTool, 'marine_forecast_unsupported'),
      );
      expect(error.message).toContain('GMZ056');
      expect(text).toContain('Recovery:');
      expect(http.calls).toHaveLength(1);
    });

    it('still raises ServiceUnavailable for a land /points missing its grid URLs', async () => {
      http.route(
        route(`${API}/points/47.6,-122.3`, {
          properties: { ...pointsResponse.properties, type: 'land', forecast: null },
        }),
      );

      const { error } = errorOf(
        await runToolContract(tools.getForecastTool, { latitude: 47.6, longitude: -122.3 }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toContain('missing required URLs');
      expect(error.data?.reason).toBeUndefined();
    });

    it.each([
      { label: 'an InvalidPoint body', body: invalidPointProblem },
      { label: 'an empty body', body: {} },
    ])('keeps out_of_scope for a /points 404 with $label', async ({ body }) => {
      http.route(route(`${API}/points/51.5,-0.1`, body, 404));

      const { error, text } = errorOf(
        await runToolContract(tools.getForecastTool, { latitude: 51.5, longitude: -0.1 }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('out_of_scope');
      expect(error.data?.recovery?.hint).toBe(
        contractRecovery(tools.getForecastTool, 'out_of_scope'),
      );
      expect(error.message).toContain('NWS only covers the US');
      expect(text).toContain('reason out_of_scope');
      expect(http.calls).toHaveLength(1);
    });

    it.each([
      { label: 'an InvalidGridpoint body', body: invalidGridpointProblem },
      { label: 'an untyped NotFound body', body: notFoundProblem },
      { label: 'no body', body: {} },
    ])('keeps the default not-found for a gridpoint 404 with $label', async ({ body }) => {
      http.route(
        route(`${API}/points/47.6,-122.3`, pointsResponse),
        route(pointsResponse.properties.forecast, body, 404),
      );

      const { error } = errorOf(
        await runToolContract(tools.getForecastTool, { latitude: 47.6, longitude: -122.3 }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.message).toBe('Requested NWS resource not found.');
      expect(error.data?.reason).toBeUndefined();
    });

    it('still returns an inland forecast on both surfaces', async () => {
      http.route(
        route(`${API}/points/47.6,-122.3`, pointsResponse),
        route(pointsResponse.properties.forecast, forecastResponse),
      );

      const result = await runToolContract(tools.getForecastTool, {
        latitude: 47.6,
        longitude: -122.3,
      });

      expect(result.structuredContent).toMatchObject({
        location: { city: 'Seattle', forecastZone: 'WAZ558' },
        periods: [{ name: 'Today' }, { name: 'Tonight' }],
      });
      expect(textOf(result)).toContain('Forecast for Seattle, WA');
    });

    it('no longer names marine areas as valid input in its out_of_scope recovery', () => {
      const recovery = contractRecovery(tools.getForecastTool, 'out_of_scope');
      expect(recovery).not.toMatch(/adjacent marine areas/i);
      expect(recovery).toMatch(/do not cover marine areas/i);
    });
  });

  describe('station tools on marine coordinates', () => {
    it('gives nws_find_stations an empty list with its no-stations notice at a gridless point', async () => {
      http.route(route(`${API}/points/28,-90`, gridlessMarinePointsResponse));

      const result = await runToolContract(tools.findStationsTool, {
        latitude: 28,
        longitude: -90,
      });
      const structured = result.structuredContent as {
        notice?: string;
        shown: number;
        stations: unknown[];
        totalCount: number;
      };

      expect(structured.stations).toEqual([]);
      expect(structured.totalCount).toBe(0);
      expect(structured.shown).toBe(0);
      expect(structured.notice).toContain('No observation stations found');
      expect(structured.notice).not.toMatch(/adjacent marine areas/i);
      expect(textOf(result)).toContain(structured.notice!);
      expect(http.calls).toHaveLength(1);
    });

    it('gives nws_get_observations no_stations_nearby at a gridless point', async () => {
      http.route(route(`${API}/points/28,-90`, gridlessMarinePointsResponse));

      const { error, text } = errorOf(
        await runToolContract(tools.getObservationsTool, { latitude: 28, longitude: -90 }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('no_stations_nearby');
      expect(error.data?.recovery?.hint).toBe(
        contractRecovery(tools.getObservationsTool, 'no_stations_nearby'),
      );
      expect(text).toContain('Recovery:');
      expect(http.calls).toHaveLength(1);
    });

    it('still serves stations and observations at a gridded marine point', async () => {
      http.route(
        route(`${API}/points/46.2,-124.1`, griddedMarinePointsResponse),
        route(`${MARINE_GRID}/stations`, stationsResponse),
        route(`${API}/stations/KSEA/observations/latest`, observationResponse),
      );

      const stations = await runToolContract(tools.findStationsTool, {
        latitude: 46.2,
        longitude: -124.1,
      });
      expect((stations.structuredContent as { stations: unknown[] }).stations).toHaveLength(3);

      const observations = await runToolContract(tools.getObservationsTool, {
        latitude: 46.2,
        longitude: -124.1,
      });
      expect(observations.structuredContent).toMatchObject({ stationId: 'KSEA' });
      expect(textOf(observations)).toContain('KSEA');
    });
  });

  describe('nws_get_zone_forecast on a marine zone', () => {
    it('turns a zone MarineForecastNotSupported into marine_forecast_unsupported, no probe', async () => {
      // The zone record is routed so a probe would be recorded: `http.calls` omits
      // requests the strict fake rejects as unhandled.
      http.route(
        route(`${API}/zones/forecast/PZZ251/forecast`, marineForecastNotSupportedProblem, 404),
        route(`${API}/zones/forecast/PZZ251`, zoneRecordResponse),
      );

      const { error, text } = errorOf(
        await runToolContract(tools.getZoneForecastTool, { zone_id: 'pzz251' }),
      );
      const hint = contractRecovery(tools.getZoneForecastTool, 'marine_forecast_unsupported');

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('marine_forecast_unsupported');
      expect(hint).toBeDefined();
      expect(error.data?.recovery?.hint).toBe(hint);
      expect(text).toContain(`Recovery: ${hint}`);
      expect(http.calls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // #40 — valid zones with no text forecast
  // -------------------------------------------------------------------------

  describe('nws_get_zone_forecast availability', () => {
    const forecastUrl = (zone: string) => `${API}/zones/forecast/${zone}/forecast`;
    const recordUrl = (zone: string) => `${API}/zones/forecast/${zone}`;

    it('returns the forecast with exactly one request when the zone answers 200', async () => {
      http.route(route(forecastUrl('WAZ315'), zoneForecastResponse));

      const result = await runToolContract(tools.getZoneForecastTool, { zone_id: 'WAZ315' });

      expect(result.structuredContent).toMatchObject({
        zoneId: 'WAZ315',
        periods: [{ name: 'Today' }, { name: 'Tonight' }],
        periodCount: 2,
      });
      expect(textOf(result)).toContain('Zone Forecast: WAZ315');
      expect(http.calls).toHaveLength(1);
    });

    it('maps an exhausted 5xx on a zone whose record exists to zone_forecast_unavailable', async () => {
      http.route(
        route(forecastUrl('AKZ829'), unexpectedProblem, 500),
        route(recordUrl('AKZ829'), zoneRecordResponse),
      );

      const { error, text } = errorOf(
        await runToolContract(tools.getZoneForecastTool, { zone_id: 'AKZ829' }),
      );
      const hint = contractRecovery(tools.getZoneForecastTool, 'zone_forecast_unavailable');

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('zone_forecast_unavailable');
      expect(hint).toBeDefined();
      expect(error.data?.recovery?.hint).toBe(hint);
      expect(error.message).toContain('HTTP 500');
      expect(text).toContain(`Recovery: ${hint}`);
      expect(text).toContain('reason zone_forecast_unavailable');
      // Same three forecast attempts as before, then one probe.
      expect(http.calls.map((c) => c.request.url)).toEqual([
        forecastUrl('AKZ829'),
        forecastUrl('AKZ829'),
        forecastUrl('AKZ829'),
        recordUrl('AKZ829'),
      ]);
      expect(backoffDelays).toEqual([2000, 4000]);
    });

    it('maps a 404 NotFound on a zone whose record exists to zone_forecast_unavailable', async () => {
      http.route(
        route(forecastUrl('PRZ001'), notFoundProblem, 404),
        route(recordUrl('PRZ001'), { properties: { id: 'PRZ001', name: 'San Juan' } }),
      );

      const { error } = errorOf(
        await runToolContract(tools.getZoneForecastTool, { zone_id: 'PRZ001' }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('zone_forecast_unavailable');
      expect(error.data?.recovery?.hint).toBe(
        contractRecovery(tools.getZoneForecastTool, 'zone_forecast_unavailable'),
      );
      expect(error.message).toContain('HTTP 404');
      expect(http.calls.map((c) => c.request.url)).toEqual([
        forecastUrl('PRZ001'),
        recordUrl('PRZ001'),
      ]);
      expect(backoffDelays).toEqual([]);
    });

    it('keeps zone_not_found when a NotFound zone has no record either (XXZ123)', async () => {
      http.route(
        route(forecastUrl('XXZ123'), notFoundProblem, 404),
        route(recordUrl('XXZ123'), notFoundProblem, 404),
      );

      const { error, text } = errorOf(
        await runToolContract(tools.getZoneForecastTool, { zone_id: 'XXZ123' }),
      );
      const hint = contractRecovery(tools.getZoneForecastTool, 'zone_not_found');

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('zone_not_found');
      expect(error.data?.recovery?.hint).toBe(hint);
      expect(text).toContain(`Recovery: ${hint}`);
      expect(http.calls).toHaveLength(2);
    });

    it('maps an exhausted 5xx on a zone with no record to zone_not_found', async () => {
      http.route(
        route(forecastUrl('QQZ001'), unexpectedProblem, 500),
        route(recordUrl('QQZ001'), notFoundProblem, 404),
      );

      const { error } = errorOf(
        await runToolContract(tools.getZoneForecastTool, { zone_id: 'QQZ001' }),
      );

      expect(error.data?.reason).toBe('zone_not_found');
      expect(http.calls).toHaveLength(4);
    });

    it('re-throws the original exhausted 5xx when the probe also fails', async () => {
      http.route(
        route(forecastUrl('AKZ829'), unexpectedProblem, 500),
        route(recordUrl('AKZ829'), unexpectedProblem, 503),
      );

      const { error } = errorOf(
        await runToolContract(tools.getZoneForecastTool, { zone_id: 'AKZ829' }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBeUndefined();
      expect(error.data?.status).toBe(500);
      expect(error.message).toContain('failed after 3 attempts');
      // The probe is a single no-retry request.
      expect(http.calls).toHaveLength(4);
    });

    it.each([
      {
        label: 'a 500',
        respond: () => json(unexpectedProblem, 500),
        code: JsonRpcErrorCode.ServiceUnavailable,
      },
      {
        label: 'a 429',
        respond: () => new Response('', { status: 429, statusText: 'Too Many Requests' }),
        code: JsonRpcErrorCode.RateLimited,
      },
      {
        label: 'a timeout',
        respond: () => {
          const error = new Error('The operation timed out.');
          error.name = 'TimeoutError';
          throw error;
        },
        code: JsonRpcErrorCode.Timeout,
      },
    ])(
      'surfaces the probe failure, not a zone answer, when the probe after a NotFound 404 hits $label',
      async ({ respond, code }) => {
        http.route(route(forecastUrl('PRZ001'), notFoundProblem, 404), {
          match: recordUrl('PRZ001'),
          respond,
        });

        const { error } = errorOf(
          await runToolContract(tools.getZoneForecastTool, { zone_id: 'PRZ001' }),
        );

        // The NotFound 404 alone cannot say whether the zone exists; no reason may claim it.
        expect(error.code).toBe(code);
        expect(error.data?.reason).toBeUndefined();
        expect(http.calls.map((c) => c.request.url)).toEqual([
          forecastUrl('PRZ001'),
          recordUrl('PRZ001'),
        ]);
      },
    );

    it.each([
      { label: 'an exhausted 500', status: 500, body: unexpectedProblem, forecastCalls: 3 },
      { label: 'a NotFound 404', status: 404, body: notFoundProblem, forecastCalls: 1 },
    ])(
      'keeps a caller disconnect during the probe after $label as RequestCancelled',
      async ({ status, body, forecastCalls }) => {
        const controller = new AbortController();
        http.route(route(forecastUrl('AKZ829'), body, status), {
          match: recordUrl('AKZ829'),
          respond: () => {
            controller.abort();
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            throw error;
          },
        });

        const { error } = errorOf(
          await runToolContract(
            tools.getZoneForecastTool,
            { zone_id: 'AKZ829' },
            { context: { signal: controller.signal } },
          ),
        );

        expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(error.data?.reason).toBeUndefined();
        expect(http.calls).toHaveLength(forecastCalls + 1);
      },
    );

    it.each([
      { status: 501, attempts: 1 },
      { status: 502, attempts: 3 },
      { status: 503, attempts: 3 },
      { status: 504, attempts: 3 },
    ])(
      'keeps an exhausted $status the baseline error, with no probe',
      async ({ status, attempts }) => {
        // A gateway or availability status says nothing about one zone's product, so it is
        // never read as "no text forecast" — only a 500 that outlives the retry budget is.
        http.route(
          { match: forecastUrl('WAZ315'), respond: () => new Response('', { status }) },
          route(recordUrl('WAZ315'), zoneRecordResponse),
        );

        const { error } = errorOf(
          await runToolContract(tools.getZoneForecastTool, { zone_id: 'WAZ315' }),
        );

        expect(error.data?.reason).toBeUndefined();
        expect(error.data?.status).toBe(status);
        expect(http.calls.map((c) => c.request.url)).toEqual(
          Array(attempts).fill(forecastUrl('WAZ315')),
        );
      },
    );

    it('returns the forecast after a transient 5xx, with no probe', async () => {
      http.route(
        { match: forecastUrl('AKZ829'), once: true, respond: () => json(unexpectedProblem, 500) },
        route(forecastUrl('AKZ829'), zoneForecastResponse),
      );

      const result = await runToolContract(tools.getZoneForecastTool, { zone_id: 'AKZ829' });

      expect(result.structuredContent).toMatchObject({ zoneId: 'AKZ829', periodCount: 2 });
      expect(textOf(result)).toContain('Zone Forecast: AKZ829');
      expect(http.calls.map((c) => c.request.url)).toEqual([
        forecastUrl('AKZ829'),
        forecastUrl('AKZ829'),
      ]);
      expect(backoffDelays).toEqual([2000]);
    });

    it.each([
      { label: 'InvalidZone (WAZ999)', zone: 'WAZ999', body: invalidZoneProblem },
      { label: 'InvalidZone (WAC033)', zone: 'WAC033', body: invalidZoneProblem },
      { label: 'no body', zone: 'WAZ999', body: {} },
    ])('keeps zone_not_found for a 404 with $label, no probe', async ({ zone, body }) => {
      // Record routed so a probe would be recorded, and would turn the answer.
      http.route(route(forecastUrl(zone), body, 404), route(recordUrl(zone), zoneRecordResponse));

      const { error, text } = errorOf(
        await runToolContract(tools.getZoneForecastTool, { zone_id: zone }),
      );
      const hint = contractRecovery(tools.getZoneForecastTool, 'zone_not_found');

      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('zone_not_found');
      expect(error.data?.recovery?.hint).toBe(hint);
      expect(text).toContain(`Recovery: ${hint}`);
      expect(http.calls).toHaveLength(1);
    });

    it('keeps a 429 as RateLimited, with no probe', async () => {
      http.route(
        {
          match: forecastUrl('WAZ315'),
          respond: () => new Response('', { status: 429, statusText: 'Too Many Requests' }),
        },
        route(recordUrl('WAZ315'), zoneRecordResponse),
      );

      const { error } = errorOf(
        await runToolContract(tools.getZoneForecastTool, { zone_id: 'WAZ315' }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data?.reason).toBeUndefined();
      expect(http.calls.map((c) => c.request.url)).toEqual(Array(3).fill(forecastUrl('WAZ315')));
    });

    it('keeps a caller disconnect as RequestCancelled, with no probe', async () => {
      const controller = new AbortController();
      http.route(
        {
          match: forecastUrl('AKZ829'),
          respond: () => {
            controller.abort();
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            throw error;
          },
        },
        route(recordUrl('AKZ829'), zoneRecordResponse),
      );

      const { error } = errorOf(
        await runToolContract(
          tools.getZoneForecastTool,
          { zone_id: 'AKZ829' },
          { context: { signal: controller.signal } },
        ),
      );

      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(http.calls).toHaveLength(1);
    });

    it('rejects a blank zone_id at the schema, before any request', async () => {
      const { error } = errorOf(
        await runToolContract(tools.getZoneForecastTool, { zone_id: '   ' }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(http.calls).toHaveLength(0);
    });

    it('declares zone_not_found for missing zones only', () => {
      const entry = tools.getZoneForecastTool.errors?.find((e) => e.reason === 'zone_not_found');
      expect(entry?.when).not.toMatch(/no forecast/i);
    });
  });

  describe('exhausted 5xx on other tools stays the baseline ServiceUnavailable', () => {
    it.each([
      {
        name: 'nws_get_forecast',
        run: (t: Tools) =>
          runToolContract(t.getForecastTool, { latitude: 47.6, longitude: -122.3 }),
        routes: [
          route(`${API}/points/47.6,-122.3`, pointsResponse),
          route(pointsResponse.properties.forecast, unexpectedProblem, 500),
        ],
      },
      {
        name: 'nws_get_observations',
        run: (t: Tools) => runToolContract(t.getObservationsTool, { station_id: 'KSEA' }),
        routes: [
          route(`${API}/stations/KSEA`, { properties: { name: 'Seattle' } }),
          route(`${API}/stations/KSEA/observations/latest`, unexpectedProblem, 500),
        ],
      },
      {
        name: 'nws_get_office_discussion',
        run: (t: Tools) => runToolContract(t.getOfficeDiscussionTool, { office: 'SEW' }),
        routes: [route(`${API}/products/types/AFD/locations/SEW`, unexpectedProblem, 500)],
      },
      {
        name: 'nws_search_alerts',
        run: (t: Tools) => runToolContract(t.searchAlertsTool, { area: 'WA' }),
        routes: [
          {
            match: (request: Request) => request.url.startsWith(`${API}/alerts/active`),
            respond: () => json(unexpectedProblem, 500),
          },
        ],
      },
    ])('$name', async ({ run, routes }) => {
      http.route(...routes);

      const { error } = errorOf(await run(tools));

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBeUndefined();
      expect(error.message).toContain('failed after 3 attempts');
      expect(backoffDelays).toEqual([2000, 4000]);
    });
  });

  /**
   * Caller-supplied IDs become single path segments. Every NWS zone, station, and
   * office ID is a plain alphanumeric token, so anything else fails as the tool's
   * not-found reason before a request: a "." or ".." segment resolves onto the
   * parent path even when percent-encoded, and an encoded traversal is refused by
   * the upstream edge.
   */
  describe('caller-supplied path IDs', () => {
    const requested = () => http.calls.map((c) => c.request.url).sort();

    it.each(['../../alerts/active', '..', '.', 'WAZ315/forecast', 'KSEA%2F', 'K SEA'])(
      'fails %j as each tool’s not-found reason with no request',
      async (id) => {
        const zone = errorOf(await runToolContract(tools.getZoneForecastTool, { zone_id: id }));
        const station = errorOf(
          await runToolContract(tools.getObservationsTool, { station_id: id }),
        );
        const office = errorOf(
          await runToolContract(tools.getOfficeDiscussionTool, { office: id }),
        );

        expect(zone.error.data?.reason).toBe('zone_not_found');
        expect(station.error.data?.reason).toBe('station_not_found');
        expect(office.error.data?.reason).toBe('no_products');
        expect(office.error.message).toContain('Verify the 3-letter WFO code');
        expect(http.calls).toHaveLength(0);
      },
    );

    it('does not serve another office’s product for office ".."', async () => {
      // "/products/types/AFD/locations/.." resolves to /products/types/AFD/, which NWS
      // redirects to the AFD list of every office.
      http.route(
        route(`${API}/products/types/AFD/`, {
          '@graph': [{ id: 'khnx1', productCode: 'AFD', issuingOffice: 'KHNX' }],
        }),
        route(`${API}/products/khnx1`, {
          issuanceTime: '2026-09-24T10:33:00+00:00',
          issuingOffice: 'KHNX',
          productCode: 'AFD',
          productName: 'Area Forecast Discussion',
          productText: 'AFDHNX\n.SYNOPSIS...',
          wmoCollectiveId: 'FXUS66',
        }),
      );

      const { error } = errorOf(
        await runToolContract(tools.getOfficeDiscussionTool, { office: '..' }),
      );

      expect(error.data?.reason).toBe('no_products');
      expect(http.calls).toHaveLength(0);
    });

    it('does not read zone "." as an existing zone with no text product', async () => {
      // "." resolves the forecast to /zones/forecast/forecast (404 NotFound) and the
      // probe to /zones/forecast/ — the zone collection, a 200.
      http.route(
        route(`${API}/zones/forecast/forecast`, notFoundProblem, 404),
        route(`${API}/zones/forecast/`, { type: 'FeatureCollection', features: [] }),
      );

      const { error } = errorOf(await runToolContract(tools.getZoneForecastTool, { zone_id: '.' }));

      expect(error.data?.reason).toBe('zone_not_found');
      expect(http.calls).toHaveLength(0);
    });

    it('does not read station "." as an existing station with no observations', async () => {
      // "." resolves the metadata leg to /stations/ — the station collection, a 200.
      http.route(
        route(`${API}/stations/`, { type: 'FeatureCollection', features: [] }),
        route(`${API}/stations/observations/latest`, notFoundProblem, 404),
      );

      const { error } = errorOf(
        await runToolContract(tools.getObservationsTool, { station_id: '.' }),
      );

      expect(error.data?.reason).toBe('station_not_found');
      expect(http.calls).toHaveLength(0);
    });

    it('requests the same URLs as before for a valid station_id', async () => {
      http.route(
        route(`${API}/stations/KSEA`, stationInfoResponse),
        route(`${API}/stations/KSEA/observations/latest`, observationResponse),
      );

      const result = await runToolContract(tools.getObservationsTool, { station_id: 'ksea' });

      expect(result.structuredContent).toMatchObject({ stationId: 'KSEA' });
      expect(requested()).toEqual([
        `${API}/stations/KSEA`,
        `${API}/stations/KSEA/observations/latest`,
      ]);
    });

    it('requests the same URLs as before for a valid office', async () => {
      http.route(
        route(`${API}/products/types/AFD/locations/SEW`, {
          '@graph': [{ id: 'abc123', productCode: 'AFD', issuingOffice: 'KSEW' }],
        }),
        route(`${API}/products/abc123`, {
          issuanceTime: '2026-09-24T10:33:00+00:00',
          issuingOffice: 'KSEW',
          productCode: 'AFD',
          productName: 'Area Forecast Discussion',
          productText: 'AFDSEW\n.SYNOPSIS...',
          wmoCollectiveId: 'FXUS66',
        }),
      );

      const result = await runToolContract(tools.getOfficeDiscussionTool, { office: 'sew' });

      expect(result.structuredContent).toMatchObject({ productCode: 'AFD' });
      expect(http.calls.map((c) => c.request.url)).toEqual([
        `${API}/products/types/AFD/locations/SEW`,
        `${API}/products/abc123`,
      ]);
    });
  });
});
