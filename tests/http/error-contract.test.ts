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
  pointsResponse,
  stationInfoResponse,
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
  payload: Record<string, unknown>,
  sessionId?: string,
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
          'MCP-Protocol-Version': PROTOCOL_VERSION,
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

describe('HTTP JSON-RPC error contracts', () => {
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
      if (url.startsWith('https://api.weather.gov/alerts/active')) {
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

  it('mirrors every provided-but-empty rejection onto both client surfaces over HTTP', async () => {
    // structuredContent-only clients read error.data.reason; format()-only clients
    // read the content[] text, where the framework mirrors data.recovery.hint.
    const cases = [
      {
        id: 'alerts-blank-area',
        tool: 'nws_search_alerts',
        args: { area: '   ' },
        reason: 'blank_location_filter',
        hint: 'Omit',
      },
      {
        id: 'alerts-empty-severity',
        tool: 'nws_search_alerts',
        args: { severity: [] },
        reason: 'empty_filter_array',
        hint: 'Omit',
      },
      {
        id: 'alerts-invalid-zone',
        tool: 'nws_search_alerts',
        args: { zone: 'QQZ123' },
        reason: 'invalid_zone',
        hint: 'WAZ558',
      },
      {
        id: 'observations-blank-station',
        tool: 'nws_get_observations',
        args: { station_id: '   ', latitude: 47.6062, longitude: -122.3321 },
        reason: 'blank_station_id',
        hint: 'Omit station_id',
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
});
