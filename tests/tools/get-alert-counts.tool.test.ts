/**
 * @fileoverview Contract tests for nws_get_alert_counts (issue #25). Each case runs
 * the real tool definition and the real NWS service through `runToolContract` over
 * a strict fetch fake, so the request, the count-map mapping, and both client
 * surfaces are exercised with nothing below the tool mocked.
 * @module tests/tools/get-alert-counts
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertCountsResponse, landOnlyAlertCountsResponse } from '../fixtures/nws-responses.js';

const COUNT_URL = 'https://api.weather.gov/alerts/active/count';

type CountsTool =
  typeof import('@/mcp-server/tools/definitions/get-alert-counts.tool.js')['getAlertCountsTool'];
type Result = Awaited<ReturnType<typeof runToolContract>>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/geo+json' },
  });
}

function textOf(result: Result): string {
  return result.content.map((block) => (block as { text: string }).text).join('\n');
}

describe('nws_get_alert_counts', () => {
  let tool: CountsTool;
  let http: FetchMockHarness;
  let origSetTimeout: typeof globalThis.setTimeout;

  beforeEach(async () => {
    vi.resetModules();
    const service = await import('@/services/nws/nws-service.js');
    service.initNwsService();
    ({ getAlertCountsTool: tool } = await import(
      '@/mcp-server/tools/definitions/get-alert-counts.tool.js'
    ));
    http = createFetchMock();
    http.install();
    origSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void) => origSetTimeout(fn, 0)) as typeof setTimeout);
  });

  afterEach(() => {
    http.restore();
    vi.unstubAllGlobals();
  });

  it('requests the count endpoint once with no query and maps the counts unchanged', async () => {
    http.route({ match: COUNT_URL, respond: () => json(alertCountsResponse) });

    const result = await runToolContract(tool, {});

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      totalAlerts: 224,
      landAlerts: 124,
      marineAlerts: 100,
      areas: alertCountsResponse.areas,
      regions: alertCountsResponse.regions,
    });
    expect(http.calls.map((c) => c.request.url)).toEqual([COUNT_URL]);
  });

  it('carries no zones map on either surface', async () => {
    http.route({ match: COUNT_URL, respond: () => json(alertCountsResponse) });

    const result = await runToolContract(tool, {});

    expect(result.structuredContent).not.toHaveProperty('zones');
    expect(textOf(result)).not.toContain('WAZ558');
  });

  it('renders every area and region, highest count first, with regions named', async () => {
    http.route({ match: COUNT_URL, respond: () => json(alertCountsResponse) });

    const text = textOf(await runToolContract(tool, {}));

    expect(text).toBe(
      [
        '## Active NWS Alerts: 224',
        '**Land:** 124 | **Marine:** 100',
        '',
        '_Counts include every message status (Test and Exercise too). An alert counts once in each area its zones fall in._',
        '',
        '### By Area (7)',
        '| Area | Alerts |',
        '|:-----|-------:|',
        '| AK | 40 |',
        '| TX | 17 |',
        '| PZ | 13 |',
        '| LS | 10 |',
        '| WA | 5 |',
        '| AL | 3 |',
        '| GU | 2 |',
        '',
        '### By Marine Region (5)',
        '| Region | Alerts |',
        '|:-------|-------:|',
        '| Alaska waters (AL) | 73 |',
        '| Eastern Pacific and US West Coast (PA) | 13 |',
        '| Great Lakes (GL) | 10 |',
        '| Gulf of Mexico (GM) | 2 |',
        '| Central and Western Pacific (PI) | 2 |',
      ].join('\n'),
    );
  });

  it('breaks count ties by code and renders a region code it has no name for as-is', async () => {
    http.route({
      match: COUNT_URL,
      respond: () =>
        json({
          ...alertCountsResponse,
          areas: { WA: 2, CA: 2, OR: 2 },
          regions: { XX: 4, AT: 4 },
        }),
    });

    const text = textOf(await runToolContract(tool, {}));

    expect(text).toContain('| CA | 2 |\n| OR | 2 |\n| WA | 2 |');
    expect(text).toContain('| Atlantic Ocean (AT) | 4 |\n| XX | 4 |');
  });

  it('answers a land-only payload with an empty regions map as a success on both surfaces', async () => {
    http.route({ match: COUNT_URL, respond: () => json(landOnlyAlertCountsResponse) });

    const result = await runToolContract(tool, {});
    const text = textOf(result);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ marineAlerts: 0, regions: {} });
    expect(text).toContain('### By Marine Region (0)\n_No marine region has an active alert._');
    expect(text).toContain('| OK | 2 |\n| KS | 1 |');
  });

  it('answers a quiet nation with both maps empty', async () => {
    http.route({
      match: COUNT_URL,
      respond: () => json({ total: 0, land: 0, marine: 0, regions: {}, areas: {}, zones: {} }),
    });

    const result = await runToolContract(tool, {});
    const text = textOf(result);

    expect(result.structuredContent).toEqual({
      totalAlerts: 0,
      landAlerts: 0,
      marineAlerts: 0,
      areas: {},
      regions: {},
    });
    expect(text).toContain('### By Area (0)\n_No area has an active alert._');
  });

  it('rejects any argument, since the endpoint takes no filters', async () => {
    const result = await runToolContract(tool, { area: 'WA' } as unknown as Record<string, never>);

    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: number } }).error.code).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
    expect(http.calls).toHaveLength(0);
  });

  it('surfaces an upstream outage as a baseline ServiceUnavailable with no declared reason', async () => {
    http.route({ match: COUNT_URL, respond: () => json({ status: 503 }, 503) });

    const result = await runToolContract(tool, {});
    const error = (
      result.structuredContent as { error: { code: number; data?: { reason?: string } } }
    ).error;

    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBeUndefined();
    expect(tool.errors).toBeUndefined();
  });

  it('states the status and per-area semantics and routes zone counts to nws_search_alerts', () => {
    expect(tool.description).toMatch(/Test and Exercise/);
    expect(tool.description).toContain('nws_search_alerts');
    expect(tool.description).toMatch(/per zone/);
    expect(tool.output.shape.totalAlerts.description).toMatch(/every message status/);
    expect(tool.output.shape.totalAlerts.description).toContain('nws_search_alerts');
    expect(tool.output.shape.areas.description).toMatch(/sum past totalAlerts/);
  });
});
