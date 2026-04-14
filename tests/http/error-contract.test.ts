/**
 * @fileoverview Transport-level HTTP regression tests for JSON-RPC error contracts.
 * @module tests/http/error-contract
 */

import http from 'node:http';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyAlertsResponse,
  pointsResponse,
  stationInfoResponse,
} from '../fixtures/nws-responses.js';

const PROTOCOL_VERSION = '2025-03-26';

type TestServer = {
  close: () => Promise<void>;
  port: number;
};

type RpcHttpResponse = {
  body: unknown;
  headers: http.IncomingHttpHeaders;
  statusCode: number;
};

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

          const finish = (parsedBody: unknown) => {
            if (settled) return;
            settled = true;
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
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
              finish(JSON.parse(data));
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
  it('returns InvalidParams for missing nws_get_observations input over HTTP', async () => {
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
        _meta: { error: { code: JsonRpcErrorCode.InvalidParams } },
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
        _meta: { error: { code: JsonRpcErrorCode.ValidationError } },
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
        _meta: { error: { code: JsonRpcErrorCode.NotFound } },
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
          count: 0,
          shown: 0,
          filters: 'national (no filters)',
        },
      });
      expect(mockFetch).toHaveBeenCalledOnce();
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
        _meta: { error: { code: JsonRpcErrorCode.NotFound } },
      });
    } finally {
      await server.close();
    }
  });
});
