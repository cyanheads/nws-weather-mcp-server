/**
 * @fileoverview Transport-level HTTP regression tests for JSON-RPC error contracts.
 * @module tests/http/error-contract
 */

import http from 'node:http';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  duplicateAlertsResponse,
  emptyAlertsResponse,
  griddedMarinePointsResponse,
  gridlessMarinePointsResponse,
  marineForecastNotSupportedProblem,
  multiPolygonZoneRecordResponse,
  notFoundProblem,
  observationResponse,
  pointsResponse,
  stationInfoResponse,
  stationsResponse,
} from '../fixtures/nws-responses.js';

const PROTOCOL_VERSION = '2025-03-26';

type TestServer = {
  close: () => Promise<void>;
  port: number;
};

type JsonRpcFrame = {
  error?: unknown;
  id?: unknown;
  method?: string;
  result?: unknown;
};

type RpcHttpResponse = {
  body: unknown;
  headers: http.IncomingHttpHeaders;
  /**
   * Server-to-client notification frames (`notifications/message` and friends)
   * that arrived on the SSE stream ahead of the response. `ctx.log` emits at
   * every level since mcp-ts-core 0.12.0, so a handler that logs interleaves
   * frames before its own result.
   */
  notifications: JsonRpcFrame[];
  statusCode: number;
};

/** A frame is the answer to a request when it carries `result` or `error`, never `method`. */
function isResponseFrame(frame: JsonRpcFrame): boolean {
  return frame.method === undefined && (frame.result !== undefined || frame.error !== undefined);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/geo+json' },
  });
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a free TCP port.')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function postJsonRpc(
  port: number,
  payload: Record<string, unknown> & { params?: { name?: string; [key: string]: unknown } },
  sessionId?: string,
  protocolVersion = PROTOCOL_VERSION,
): Promise<RpcHttpResponse> {
  const body = JSON.stringify(payload);

  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
          'MCP-Protocol-Version': protocolVersion,
          'Mcp-Method': String(payload.method),
          ...(payload.params?.name ? { 'Mcp-Name': payload.params.name } : {}),
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
      },
      (response) => {
        response.setEncoding('utf8');
        const contentType = String(response.headers['content-type'] ?? '');

        if (contentType.includes('text/event-stream')) {
          let buffer = '';
          let settled = false;
          const notifications: JsonRpcFrame[] = [];

          const finish = (parsedBody: unknown) => {
            if (settled) return;
            settled = true;
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              notifications,
              body: parsedBody,
            });
            response.destroy();
          };

          response.on('data', (chunk) => {
            buffer += chunk.replace(/\r\n/g, '\n');

            while (buffer.includes('\n\n')) {
              const separatorIndex = buffer.indexOf('\n\n');
              const frame = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);

              const data = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n')
                .trim();

              if (data.length === 0) continue;
              const parsed = JSON.parse(data) as JsonRpcFrame;
              // Notifications (ctx.log, progress) stream ahead of the answer.
              if (!isResponseFrame(parsed)) {
                notifications.push(parsed);
                continue;
              }
              finish(parsed);
              return;
            }
          });

          response.on('error', reject);
          response.on('end', () => finish(null));
          return;
        }

        let raw = '';
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            notifications: [],
            body: raw.length > 0 ? JSON.parse(raw) : null,
          });
        });
      },
    );

    request.once('error', reject);
    request.write(body);
    request.end();
  });
}

async function initializeSession(port: number): Promise<string> {
  const initialize = await postJsonRpc(port, {
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'vitest',
        version: '1.0.0',
      },
    },
  });

  const initializeBody = initialize.body as { result?: unknown } | null;
  expect(initialize.statusCode).toBe(200);
  expect(initializeBody?.result).toBeDefined();

  const sessionId = headerValue(initialize.headers['mcp-session-id']);
  expect(sessionId).toBeTruthy();

  const initialized = await postJsonRpc(
    port,
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    },
    sessionId,
  );

  expect([200, 202, 204]).toContain(initialized.statusCode);

  return sessionId!;
}

async function startHttpTestServer(mockFetch: typeof fetch): Promise<TestServer> {
  const envKeys = [
    'NODE_ENV',
    'MCP_TRANSPORT_TYPE',
    'MCP_HTTP_HOST',
    'MCP_HTTP_PORT',
    'MCP_HTTP_ENDPOINT_PATH',
    'MCP_AUTH_MODE',
    'MCP_LOG_LEVEL',
    'NWS_USER_AGENT',
  ] as const;
  const envSnapshot = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const port = await getFreePort();

  vi.resetModules();
  globalThis.fetch = mockFetch;

  process.env.NODE_ENV = 'test';
  process.env.MCP_TRANSPORT_TYPE = 'http';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.MCP_HTTP_PORT = String(port);
  process.env.MCP_HTTP_ENDPOINT_PATH = '/mcp';
  process.env.MCP_AUTH_MODE = 'none';
  process.env.MCP_LOG_LEVEL = 'emerg';
  process.env.NWS_USER_AGENT =
    '(nws-weather-mcp-server-test, github.com/cyanheads/nws-weather-mcp-server)';

  const { resetConfig } = await import('@cyanheads/mcp-ts-core/config');
  resetConfig();

  const { createApp } = await import('@cyanheads/mcp-ts-core');
  const { alertTypesResource } = await import('@/mcp-server/resources/definitions/index.js');
  const {
    findStationsTool,
    getForecastTool,
    getObservationsTool,
    getOfficeDiscussionTool,
    getZoneForecastTool,
    listAlertTypesTool,
    searchAlertsTool,
  } = await import('@/mcp-server/tools/definitions/index.js');
  const { initNwsService } = await import('@/services/nws/nws-service.js');

  const handle = await createApp({
    tools: [
      getForecastTool,
      searchAlertsTool,
      getObservationsTool,
      findStationsTool,
      listAlertTypesTool,
      getOfficeDiscussionTool,
      getZoneForecastTool,
    ],
    resources: [alertTypesResource],
    setup() {
      initNwsService();
    },
  });

  return {
    port,
    async close() {
      await handle.shutdown('test');
      restoreEnv(envSnapshot);
      globalThis.fetch = originalFetch;
      resetConfig();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Every test boots a real server; a cold createApp() can run past the 5 s default.
describe('HTTP JSON-RPC error contracts', { timeout: 30_000 }, () => {
  it('returns ValidationError for missing nws_get_observations input over HTTP', async () => {
    const mockFetch = vi.fn<typeof fetch>();
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'missing-observations-input',
          method: 'tools/call',
          params: {
            name: 'nws_get_observations',
            arguments: {},
          },
        },
        sessionId,
      );

      const body = response.body as { result?: unknown };
      expect(response.statusCode).toBe(200);
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: { reason: 'missing_input' },
          },
        },
      });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('returns ValidationError for out-of-scope forecast coordinates over HTTP', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 404));
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'forecast-out-of-scope',
          method: 'tools/call',
          params: {
            name: 'nws_get_forecast',
            arguments: {
              latitude: 47.6032,
              longitude: 122.3303,
              hourly: false,
            },
          },
        },
        sessionId,
      );

      const body = response.body as { result?: unknown };
      expect(response.statusCode).toBe(200);
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.ValidationError } },
      });
    } finally {
      await server.close();
    }
  });

  it('returns NotFound when no nearby observation stations exist over HTTP', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/points/47.6,-122.3')) {
        return jsonResponse(pointsResponse);
      }
      if (url === pointsResponse.properties.observationStations) {
        return jsonResponse({ features: [] });
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'observations-no-stations',
          method: 'tools/call',
          params: {
            name: 'nws_get_observations',
            arguments: {
              latitude: 47.6,
              longitude: -122.3,
            },
          },
        },
        sessionId,
      );

      const body = response.body as { result?: unknown };
      expect(response.statusCode).toBe(200);
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.NotFound } },
      });
    } finally {
      await server.close();
    }
  });

  it('uses the default actual alert status end to end over HTTP', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://api.weather.gov/alerts/active?status=actual') {
        return jsonResponse(emptyAlertsResponse);
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'alerts-default-status',
          method: 'tools/call',
          params: {
            name: 'nws_search_alerts',
            arguments: {},
          },
        },
        sessionId,
      );

      const body = response.body as { result?: unknown };
      expect(response.statusCode).toBe(200);
      expect(body.result).toMatchObject({
        structuredContent: {
          alerts: [],
          totalCount: 0,
          shown: 0,
          appliedFilters: 'national (no filters)',
        },
      });
      expect(mockFetch).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it('collapses duplicate upstream alerts on both response surfaces over HTTP (issue #36)', async () => {
    // Clients read different surfaces — structuredContent or content[] — so the
    // collapsed set and the distinct-alert counts have to hold on both.
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      const { origin, pathname } = new URL(url);
      if (origin === 'https://api.weather.gov' && pathname.startsWith('/alerts/active')) {
        return jsonResponse(duplicateAlertsResponse);
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'alerts-duplicate-collapse',
          method: 'tools/call',
          params: {
            name: 'nws_search_alerts',
            arguments: { area: 'WA' },
          },
        },
        sessionId,
      );

      const result = (response.body as { result: unknown }).result as {
        content: { type: string; text: string }[];
        structuredContent: { alerts: { id: string }[]; shown: number; totalCount: number };
      };
      expect(response.statusCode).toBe(200);

      // Upstream sent three features; two of them are the same alert.
      expect(result.structuredContent.alerts.map((alert) => alert.id)).toEqual([
        'urn:oid:duplicated-air-quality',
        'urn:oid:distinct-wind-advisory',
      ]);
      expect(result.structuredContent.totalCount).toBe(2);
      expect(result.structuredContent.shown).toBe(2);

      const text = result.content.map((block) => block.text).join('\n');
      expect(text.match(/urn:oid:duplicated-air-quality/g)).toHaveLength(1);
      expect(text).toContain('urn:oid:distinct-wind-advisory');
      expect(text).toContain('2 Active Alerts');
      // Both counts ride the content[] trailer under their labels, so a client
      // that only reads text sees the same pair of numbers.
      expect(text).toContain('**Total Alerts:** 2');
      expect(text).toContain('**Shown:** 2');
    } finally {
      await server.close();
    }
  });

  it('returns ValidationError for out-of-scope nws_find_stations coordinates over HTTP', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 404));
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'find-stations-out-of-scope',
          method: 'tools/call',
          params: {
            name: 'nws_find_stations',
            arguments: {
              latitude: 47.6032,
              longitude: 122.3303,
              limit: 5,
            },
          },
        },
        sessionId,
      );

      const body = response.body as { result?: unknown };
      expect(response.statusCode).toBe(200);
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.ValidationError } },
      });
    } finally {
      await server.close();
    }
  });

  it('mirrors every local input rejection onto both client surfaces over HTTP', async () => {
    // structuredContent-only clients read error.data.reason; format()-only clients
    // read the content[] text, where the framework mirrors data.recovery.hint.
    const cases = [
      {
        id: 'alerts-invalid-zone',
        tool: 'nws_search_alerts',
        args: { zone: 'QQZ123' },
        reason: 'invalid_zone',
        hint: 'WAZ558',
      },
      {
        id: 'alerts-mutually-exclusive',
        tool: 'nws_search_alerts',
        // The blank zone is unset, so only area and point conflict.
        args: { area: 'WA', point: '47.6,-122.3', zone: '' },
        reason: 'mutually_exclusive_filters',
        hint: 'at most one',
      },
      {
        // A blank station_id is unset (issue #46); with no coordinates the call
        // carries no input at all.
        id: 'observations-blank-station-alone',
        tool: 'nws_get_observations',
        args: { station_id: '   ' },
        reason: 'missing_input',
        hint: 'station_id or both latitude and longitude',
      },
    ] as const;

    const mockFetch = vi.fn<typeof fetch>();
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);

      for (const testCase of cases) {
        const response = await postJsonRpc(
          server.port,
          {
            jsonrpc: '2.0',
            id: testCase.id,
            method: 'tools/call',
            params: { name: testCase.tool, arguments: testCase.args },
          },
          sessionId,
        );

        const body = response.body as {
          result?: { content: { type: string; text: string }[] };
        };
        expect(response.statusCode, testCase.id).toBe(200);
        expect(body.result, testCase.id).toMatchObject({
          isError: true,
          structuredContent: {
            error: {
              code: JsonRpcErrorCode.ValidationError,
              data: { reason: testCase.reason },
            },
          },
        });

        const text = body
          .result!.content.filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        expect(text, testCase.id).toContain('Recovery:');
        expect(text, testCase.id).toContain(testCase.hint);
      }

      // Every rejection is local — nothing reached the NWS API.
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('treats blank optional inputs as unset end to end over HTTP (issue #46)', async () => {
    const API = 'https://api.weather.gov';
    const requested: string[] = [];
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      requested.push(url);
      const { origin, pathname } = new URL(url);
      if (origin === API && pathname === '/alerts/active') return jsonResponse(emptyAlertsResponse);
      if (url === `${API}/points/47.6062,-122.3321`) return jsonResponse(pointsResponse);
      if (url === pointsResponse.properties.observationStations) {
        return jsonResponse(stationsResponse);
      }
      // KBFI is the fixture station nearest the step-3 coordinates.
      if (url === `${API}/stations/KBFI/observations/latest`) {
        return jsonResponse(observationResponse);
      }
      if (url === `${API}/products/types/AFD/locations/SEW`) {
        return jsonResponse({ '@graph': [{ id: 'afd-sew-1' }] });
      }
      if (url === `${API}/products/afd-sew-1`) {
        return jsonResponse({
          issuanceTime: '2026-09-30T10:33:00+00:00',
          issuingOffice: 'KSEW',
          productCode: 'AFD',
          productName: 'Area Forecast Discussion',
          productText: 'AFDSEW\n.SYNOPSIS...',
          wmoCollectiveId: 'FXUS66',
        });
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const server = await startHttpTestServer(mockFetch);

    type ToolResult = {
      content: { type: string; text?: string }[];
      isError?: boolean;
      structuredContent: Record<string, unknown>;
    };
    let sessionId = '';
    const call = async (id: string, name: string, args: Record<string, unknown>) => {
      requested.length = 0;
      const response = await postJsonRpc(
        server.port,
        { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
        sessionId,
      );
      expect(response.statusCode, id).toBe(200);
      const result = (response.body as { result: ToolResult }).result;
      expect(result.isError, `${id}: ${JSON.stringify(result.structuredContent)}`).toBeFalsy();
      return { result, text: contentText(result), requested: [...requested] };
    };

    try {
      sessionId = await initializeSession(server.port);

      // Steps 1, 2, and 4a from the issue, plus the national-search acceptance
      // cases: each blank is left off the request and out of the filter echo.
      const alertCases = [
        {
          id: 'blank-point-zone',
          args: { area: 'WA', point: '', zone: '' },
          query: '?area=WA&status=actual',
          filters: 'area=WA',
        },
        {
          id: 'empty-arrays',
          args: { area: 'WA', event: [], severity: [], urgency: [], certainty: [], region: [] },
          query: '?area=WA&status=actual',
          filters: 'area=WA',
        },
        {
          id: 'blank-area',
          args: { area: '' },
          query: '?status=actual',
          filters: 'national (no filters)',
        },
        {
          id: 'blank-event-entry',
          args: { event: [''] },
          query: '?status=actual',
          filters: 'national (no filters)',
        },
        {
          id: 'empty-severity',
          args: { severity: [] },
          query: '?status=actual',
          filters: 'national (no filters)',
        },
        {
          id: 'blank-region-type',
          args: { region_type: '' },
          query: '?status=actual',
          filters: 'national (no filters)',
        },
        {
          id: 'blank-status',
          args: { area: 'WA', status: '' },
          query: '?area=WA&status=actual',
          filters: 'area=WA',
        },
      ];
      for (const testCase of alertCases) {
        const { result, text, requested } = await call(
          testCase.id,
          'nws_search_alerts',
          testCase.args,
        );
        expect(requested, testCase.id).toEqual([`${API}/alerts/active${testCase.query}`]);
        expect(result.structuredContent.appliedFilters, testCase.id).toBe(testCase.filters);
        expect(text, testCase.id).toContain(`**Filters:** ${testCase.filters}`);
      }

      // Step 3: the blank station_id is unset, so the coordinates resolve the
      // nearest station, and the response names the station it served.
      const observations = await call('blank-station-id', 'nws_get_observations', {
        station_id: '',
        latitude: 47.6062,
        longitude: -122.3321,
      });
      expect(observations.requested).toEqual([
        `${API}/points/47.6062,-122.3321`,
        pointsResponse.properties.observationStations,
        `${API}/stations/KBFI/observations/latest`,
      ]);
      expect(observations.result.structuredContent).toMatchObject({
        stationId: 'KBFI',
        station: 'KBFI',
      });
      expect(observations.text).toContain('**Station:** KBFI');

      // Step 4b: a blank product_type falls back to its AFD default.
      const discussion = await call('blank-product-type', 'nws_get_office_discussion', {
        office: 'SEW',
        product_type: '',
      });
      expect(discussion.requested).toEqual([
        `${API}/products/types/AFD/locations/SEW`,
        `${API}/products/afd-sew-1`,
      ]);
      expect(discussion.result.structuredContent).toMatchObject({ productCode: 'AFD' });
      expect(discussion.text).toContain('Area Forecast Discussion (AFD)');
    } finally {
      await server.close();
    }
  });

  it('returns NotFound when a direct station has no recent observations over HTTP', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://api.weather.gov/stations/KSEA') {
        return jsonResponse(stationInfoResponse);
      }
      if (url === 'https://api.weather.gov/stations/KSEA/observations/latest') {
        return jsonResponse({
          properties: {
            timestamp: null,
            textDescription: 'Not available',
          },
        });
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'station-without-observation',
          method: 'tools/call',
          params: {
            name: 'nws_get_observations',
            arguments: {
              station_id: 'KSEA',
            },
          },
        },
        sessionId,
      );

      const body = response.body as { result?: unknown };
      expect(response.statusCode).toBe(200);
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.NotFound } },
      });
    } finally {
      await server.close();
    }
  });

  it('streams handler ctx.log lines to the client as notifications/message', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://api.weather.gov/alerts/active?status=actual') {
        return jsonResponse(emptyAlertsResponse);
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'alerts-log-notifications',
          method: 'tools/call',
          params: {
            name: 'nws_search_alerts',
            arguments: {},
          },
        },
        sessionId,
      );

      expect(response.statusCode).toBe(200);
      expect((response.body as { result?: unknown }).result).toBeDefined();

      // The handler's ctx.log calls reach the client ahead of the result.
      const logFrames = response.notifications.filter(
        (frame) => frame.method === 'notifications/message',
      ) as { params: { data: { message: string }; level: string } }[];
      expect(logFrames.length).toBeGreaterThan(0);
      expect(logFrames.map((frame) => frame.params.data.message)).toContain(
        'Alerts search completed',
      );
      expect(logFrames.every((frame) => frame.params.level === 'info')).toBe(true);
    } finally {
      await server.close();
    }
  });

  /** Text of every `content[]` text block, joined — what a format()-only client reads. */
  function contentText(result: { content: { type: string; text?: string }[] }): string {
    return result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
  }

  it('returns marine_forecast_unsupported on both surfaces for a marine gridpoint over HTTP (issue #38)', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://api.weather.gov/points/46.2,-124.1') {
        return jsonResponse(griddedMarinePointsResponse);
      }
      if (url === griddedMarinePointsResponse.properties.forecast) {
        return jsonResponse(marineForecastNotSupportedProblem, 404);
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'forecast-marine',
          method: 'tools/call',
          params: { name: 'nws_get_forecast', arguments: { latitude: 46.2, longitude: -124.1 } },
        },
        sessionId,
      );

      const result = (response.body as { result: Parameters<typeof contentText>[0] }).result;
      expect(response.statusCode).toBe(200);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.NotFound,
            data: {
              reason: 'marine_forecast_unsupported',
              recovery: { hint: expect.stringContaining('nws_search_alerts') },
            },
          },
        },
      });
      const text = contentText(result);
      expect(text).toContain('Recovery:');
      expect(text).toContain('reason marine_forecast_unsupported');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it('returns an empty station list with a notice for a gridless marine point over HTTP (issue #38)', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://api.weather.gov/points/28,-90') {
        return jsonResponse(gridlessMarinePointsResponse);
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'stations-gridless-marine',
          method: 'tools/call',
          params: { name: 'nws_find_stations', arguments: { latitude: 28, longitude: -90 } },
        },
        sessionId,
      );

      const result = (
        response.body as {
          result: Parameters<typeof contentText>[0] & {
            isError?: boolean;
            structuredContent: { notice: string; stations: unknown[]; totalCount: number };
          };
        }
      ).result;
      expect(response.statusCode).toBe(200);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.stations).toEqual([]);
      expect(result.structuredContent.totalCount).toBe(0);
      expect(contentText(result)).toContain(result.structuredContent.notice);
      expect(mockFetch).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it('returns zone_forecast_unavailable with a point inside the zone over HTTP (issues #40, #42)', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://api.weather.gov/zones/forecast/PRZ001/forecast') {
        return jsonResponse(notFoundProblem, 404);
      }
      if (url === 'https://api.weather.gov/zones/forecast/PRZ001') {
        return jsonResponse(multiPolygonZoneRecordResponse);
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'zone-forecast-unavailable',
          method: 'tools/call',
          params: { name: 'nws_get_zone_forecast', arguments: { zone_id: 'PRZ001' } },
        },
        sessionId,
      );

      const result = (response.body as { result: Parameters<typeof contentText>[0] }).result;
      expect(response.statusCode).toBe(200);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.NotFound,
            message: expect.stringContaining('HTTP 404'),
            data: {
              reason: 'zone_forecast_unavailable',
              latitude: 66,
              longitude: -159,
              recovery: {
                hint: expect.stringContaining(
                  'nws_get_forecast with latitude 66 and longitude -159',
                ),
              },
            },
          },
        },
      });
      const text = contentText(result);
      expect(text).toContain('(66, -159) is a point inside the zone.');
      expect(text).toContain('Recovery: Call nws_get_forecast with latitude 66 and longitude -159');
      expect(text).toContain('reason zone_forecast_unavailable');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it('logs declared caller outcomes at their contract severity and baseline faults at error (issue #43)', async () => {
    const API = 'https://api.weather.gov';
    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${API}/zones/forecast/PRZ001/forecast`)
        return jsonResponse(notFoundProblem, 404);
      if (url === `${API}/zones/forecast/PRZ001`)
        return jsonResponse(multiPolygonZoneRecordResponse);
      if (url === `${API}/alerts/active?status=actual`) {
        return jsonResponse({ title: 'Unexpected Problem', status: 500 }, 500);
      }
      throw new Error(`Unexpected upstream URL: ${url}`);
    });
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      // The same singleton the framework's ErrorHandler writes the
      // `Error in tool:<name>` record through; spied after boot so every spy
      // sees the server's calls.
      const { logger } = await import('@cyanheads/mcp-ts-core/utils');
      const levels = ['debug', 'info', 'notice', 'warning', 'error'] as const;
      const spies = levels.map((level) => [level, vi.spyOn(logger, level)] as const);

      /** Levels the call's failure record was written at. */
      const failureLevels = async (id: string, name: string, args: Record<string, unknown>) => {
        for (const [, spy] of spies) spy.mockClear();
        const response = await postJsonRpc(
          server.port,
          { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
          sessionId,
        );
        expect((response.body as { result: { isError?: boolean } }).result.isError, id).toBe(true);
        return spies
          .filter(([, spy]) =>
            spy.mock.calls.some(([message]) =>
              String(message).startsWith(`Error in tool:${name}:`),
            ),
          )
          .map(([level]) => level);
      };

      // Service-thrown, rejected before any request.
      expect(
        await failureLevels('zone-bad-id', 'nws_get_zone_forecast', { zone_id: 'X-Y' }),
      ).toEqual(['notice']);
      // Handler-thrown via ctx.fail.
      expect(await failureLevels('alerts-bad-area', 'nws_search_alerts', { area: 'ZZ' })).toEqual([
        'notice',
      ]);
      expect(await failureLevels('observations-empty', 'nws_get_observations', {})).toEqual([
        'notice',
      ]);
      // The zone forecast endpoint failed while the zone record answered.
      expect(
        await failureLevels('zone-unavailable', 'nws_get_zone_forecast', { zone_id: 'PRZ001' }),
      ).toEqual(['warning']);
      // An exhausted 5xx is a baseline ServiceUnavailable no entry declares.
      expect(await failureLevels('alerts-exhausted-500', 'nws_search_alerts', {})).toEqual([
        'error',
      ]);
    } finally {
      await server.close();
    }
  });

  it('rejects an undeclared tool argument by name', async () => {
    const mockFetch = vi.fn<typeof fetch>();
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        {
          jsonrpc: '2.0',
          id: 'find-stations-unknown-key',
          method: 'tools/call',
          params: {
            name: 'nws_find_stations',
            arguments: {
              latitude: 47.6,
              longitude: -122.3,
              // Not on the schema. Tool inputs advertise additionalProperties:
              // false, so this is rejected by name instead of stripped.
              radius_km: 50,
            },
          },
        },
        sessionId,
      );

      expect(response.statusCode).toBe(200);
      const body = response.body as { result?: { isError?: boolean }; error?: { message: string } };
      const message = body.error?.message ?? JSON.stringify(body.result);
      expect(message).toContain('radius_km');
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each(['2025-11-25', '2026-07-28'])(
    'returns InvalidParams on both surfaces for schema rejections under %s',
    async (protocolVersion) => {
      const mockFetch = vi.fn<typeof fetch>();
      const server = await startHttpTestServer(mockFetch);

      try {
        let sessionId: string | undefined;
        if (protocolVersion !== '2026-07-28') {
          const initialized = await postJsonRpc(
            server.port,
            {
              jsonrpc: '2.0',
              id: 'initialize',
              method: 'initialize',
              params: {
                protocolVersion,
                capabilities: {},
                clientInfo: { name: 'vitest', version: '1.0.0' },
              },
            },
            undefined,
            protocolVersion,
          );
          expect(initialized.statusCode).toBe(200);
          expect(initialized.body).toMatchObject({ result: { protocolVersion } });
          sessionId = headerValue(initialized.headers['mcp-session-id']);
          await postJsonRpc(
            server.port,
            {
              jsonrpc: '2.0',
              method: 'notifications/initialized',
              params: {},
            },
            sessionId,
            protocolVersion,
          );
        }

        const cases = [
          { args: { latitude: 47.6, longitude: -122.3, radius_km: 50 }, field: 'radius_km' },
          { args: { latitude: '47.6', longitude: -122.3 }, field: 'latitude' },
          { args: { longitude: -122.3 }, field: 'latitude' },
          { args: { latitude: 91, longitude: -122.3 }, field: 'latitude' },
        ];
        for (const { args, field } of cases) {
          const response = await postJsonRpc(
            server.port,
            {
              jsonrpc: '2.0',
              id: `invalid-${field}`,
              method: 'tools/call',
              params: {
                name: 'nws_find_stations',
                arguments: args,
                ...(protocolVersion === '2026-07-28'
                  ? {
                      _meta: {
                        'io.modelcontextprotocol/protocolVersion': protocolVersion,
                        'io.modelcontextprotocol/clientInfo': { name: 'vitest', version: '1.0.0' },
                        'io.modelcontextprotocol/clientCapabilities': {},
                      },
                    }
                  : {}),
              },
            },
            sessionId,
            protocolVersion,
          );
          expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
          expect(response.body).toMatchObject({
            result: {
              isError: true,
              structuredContent: {
                error: {
                  code: JsonRpcErrorCode.InvalidParams,
                  message: expect.stringContaining(field),
                },
              },
              content: expect.arrayContaining([
                expect.objectContaining({ type: 'text', text: expect.stringContaining(field) }),
              ]),
            },
          });
        }
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    },
  );

  it('advertises strict inputs and the error envelope on tools/list', async () => {
    const mockFetch = vi.fn<typeof fetch>();
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        { jsonrpc: '2.0', id: 'tools-list', method: 'tools/list', params: {} },
        sessionId,
      );

      expect(response.statusCode).toBe(200);
      const tools = (
        response.body as {
          result: {
            tools: {
              inputSchema: Record<string, unknown>;
              name: string;
              outputSchema?: { properties?: Record<string, unknown> };
            }[];
          };
        }
      ).result.tools;

      const findStations = tools.find((entry) => entry.name === 'nws_find_stations');
      expect(findStations).toBeDefined();
      // Strict inputs (0.12.0): the advertised schema forbids extra keys.
      expect(findStations?.inputSchema.additionalProperties).toBe(false);
      expect(findStations?.inputSchema.$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
      // The advertised outputSchema declares the failure envelope alongside
      // the success fields, so a validating client accepts an error result.
      expect(findStations?.outputSchema?.properties).toHaveProperty('error');
      expect(findStations?.outputSchema?.properties).toHaveProperty('stations');
    } finally {
      await server.close();
    }
  });

  it('advertises the optional inputs a form client may blank with unchanged schemas (issue #46)', async () => {
    const mockFetch = vi.fn<typeof fetch>();
    const server = await startHttpTestServer(mockFetch);

    try {
      const sessionId = await initializeSession(server.port);
      const response = await postJsonRpc(
        server.port,
        { jsonrpc: '2.0', id: 'tools-list-blank-inputs', method: 'tools/list', params: {} },
        sessionId,
      );

      type InputSchema = {
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      const tools = (
        response.body as { result: { tools: { inputSchema: InputSchema; name: string }[] } }
      ).result.tools;
      const inputOf = (name: string) => tools.find((entry) => entry.name === name)?.inputSchema;

      // A blank is unset at parse time; the advertised contract stays the same.
      const alerts = inputOf('nws_search_alerts');
      expect(alerts?.properties.region_type).toEqual({
        description: expect.any(String),
        type: 'string',
        enum: ['Land', 'Marine'],
      });
      expect(alerts?.properties.status).toEqual({
        description: expect.any(String),
        default: 'Actual',
        type: 'string',
        enum: ['Actual', 'Exercise', 'System', 'Test', 'Draft'],
      });
      for (const field of ['area', 'point', 'zone']) {
        expect(alerts?.properties[field], field).toEqual({
          description: expect.any(String),
          type: 'string',
        });
      }
      for (const field of ['region', 'event', 'severity', 'urgency', 'certainty']) {
        expect(alerts?.properties[field], field).toMatchObject({ type: 'array' });
        expect(alerts?.properties[field], field).not.toHaveProperty('minItems');
      }
      expect(alerts?.required ?? []).toEqual([]);

      const discussion = inputOf('nws_get_office_discussion');
      expect(discussion?.properties.product_type).toEqual({
        description: expect.any(String),
        default: 'AFD',
        type: 'string',
        enum: ['AFD', 'HWO', 'ZFP', 'SPS'],
      });
      expect(discussion?.required).toEqual(['office']);

      const observations = inputOf('nws_get_observations');
      expect(observations?.properties.station_id).toEqual({
        description: expect.any(String),
        type: 'string',
      });
      expect(observations?.required ?? []).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe('declared error severities (issue #43)', () => {
  it('logs every modeled caller outcome below error, per tool and reason', async () => {
    const tools = await import('@/mcp-server/tools/definitions/index.js');
    const severities = Object.fromEntries(
      Object.values(tools).map((definition) => [
        definition.name,
        Object.fromEntries(
          (definition.errors ?? []).map((entry) => [entry.reason, entry.severity]),
        ),
      ]),
    );

    expect(severities).toEqual({
      nws_get_forecast: {
        out_of_scope: 'notice',
        marine_forecast_unsupported: 'notice',
        no_forecast_grid: 'notice',
      },
      nws_search_alerts: {
        mutually_exclusive_filters: 'notice',
        invalid_area_code: 'notice',
        invalid_point: 'notice',
        invalid_zone: 'notice',
      },
      nws_get_observations: {
        missing_input: 'notice',
        station_not_found: 'notice',
        no_observations: 'notice',
        no_stations_nearby: 'notice',
        out_of_scope: 'notice',
      },
      nws_get_observation_history: {
        station_not_found: 'notice',
        invalid_time_window: 'notice',
      },
      nws_find_stations: { out_of_scope: 'notice' },
      nws_get_office_discussion: { no_products: 'notice' },
      nws_get_zone_forecast: {
        zone_not_found: 'notice',
        zone_forecast_unavailable: 'warning',
        marine_forecast_unsupported: 'notice',
      },
      // No contract: failures here are baseline faults and keep error.
      nws_list_alert_types: {},
      nws_get_alert_counts: {},
    });
  });
});
