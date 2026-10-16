/**
 * @fileoverview Tests for nws_get_alert. Each case runs the real tool definition and
 * the real NWS service through `runToolContract` over a strict fetch fake, so the ID
 * guard, the 404 mapping, the shared alert parser, and both client surfaces are
 * exercised — nothing below the tool is mocked.
 * @module tests/tools/get-alert
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGED_OUT_ALERT_ID,
  CURRENT_ALERT_ID,
  currentAlertFeature,
  invalidAlertProblem,
  KEEPALIVE_ALERT_ID,
  keepaliveAlertFeature,
  SUPERSEDED_ALERT_ID,
  supersededAlertFeature,
} from '../fixtures/nws-responses.js';

const API = 'https://api.weather.gov';

/** The recovery hint every alert_not_found failure carries. */
const RECOVERY =
  'Pass an id from nws_search_alerts, or a references[].identifier from an alert it returned, exactly as given; NWS no longer serves messages sent more than about 7 days ago.';

/** Every route answers each request with a fresh Response built from the body. */
function route(match: string, body: unknown, status = 200) {
  return {
    match,
    respond: () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/geo+json' },
      }),
  };
}

type Tools = typeof import('@/mcp-server/tools/definitions/index.js');
type ContractResult = Awaited<ReturnType<typeof runToolContract>>;
type AlertPayload = {
  alert: { id: string; messageType: string; sent: string; references: { identifier: string }[] };
};

/** Text of every content block, joined. */
function textOf(result: ContractResult): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n');
}

describe('nws_get_alert', () => {
  let tools: Tools;
  let http: FetchMockHarness;

  beforeEach(async () => {
    vi.resetModules();
    const service = await import('@/services/nws/nws-service.js');
    service.initNwsService();
    tools = await import('@/mcp-server/tools/definitions/index.js');

    // Strict: an unrouted URL rejects, so no test can reach live NWS.
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('returns a current alert on both surfaces, field for field as nws_search_alerts does', async () => {
    http.route(
      route(`${API}/alerts/${CURRENT_ALERT_ID}`, currentAlertFeature),
      route(`${API}/alerts/active?status=actual`, { features: [currentAlertFeature] }),
    );

    const fetched = await runToolContract(tools.getAlertTool, { alert_id: CURRENT_ALERT_ID });
    const searched = await runToolContract(tools.searchAlertsTool, {});

    expect(fetched.isError).toBeFalsy();
    const { alert } = fetched.structuredContent as { alert: Record<string, unknown> };
    const [searchedAlert] = (searched.structuredContent as { alerts: Record<string, unknown>[] })
      .alerts;
    expect(alert).toEqual(searchedAlert);
    expect(Object.keys(alert).sort()).toEqual(
      Object.keys(tools.searchAlertsTool.output.shape.alerts.element.shape).sort(),
    );

    // content[] carries the same per-alert block the search renders, under its own heading.
    const text = textOf(fetched);
    const searchedText = textOf(searched);
    const blockStart = searchedText.indexOf(`### Freeze Warning\n_ID: ${CURRENT_ALERT_ID}_\n`);
    const blockEnd = searchedText.indexOf('\n\n---', blockStart);
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(text).toBe(`## Alert Message\n\n${searchedText.slice(blockStart, blockEnd)}`);
    expect(text).toContain(`**Supersedes:** ${SUPERSEDED_ALERT_ID}`);
    expect(text).toContain('**Zones:** NDZ001 (forecast), NDZ002 (forecast), NDZ003 (forecast)');
    expect(text).toContain('**Recommended Actions:** Take steps now');
    expect(text).toContain('Sub-freezing temperatures as low as 25 expected.');
  });

  it('walks a revision chain one call per message, references[0] first', async () => {
    const olderId = 'urn:oid:2.49.0.1.840.0.478df6166ade7585f4aed605340188fa5f655ff1.001.2';
    http.route(
      route(`${API}/alerts/${CURRENT_ALERT_ID}`, currentAlertFeature),
      route(`${API}/alerts/${SUPERSEDED_ALERT_ID}`, supersededAlertFeature),
      route(`${API}/alerts/${olderId}`, invalidAlertProblem, 404),
    );

    const current = await runToolContract(tools.getAlertTool, { alert_id: CURRENT_ALERT_ID });
    const firstHop = (current.structuredContent as AlertPayload).alert.references[0]!.identifier;
    expect(firstHop).toBe(SUPERSEDED_ALERT_ID);

    const superseded = await runToolContract(tools.getAlertTool, { alert_id: firstHop });
    expect(superseded.isError).toBeFalsy();
    const prior = (superseded.structuredContent as AlertPayload).alert;
    expect(prior).toMatchObject({
      id: SUPERSEDED_ALERT_ID,
      messageType: 'Update',
      sent: '2026-10-16T01:14:00-05:00',
    });
    expect(prior.references.map((r) => r.identifier)).toEqual([
      olderId,
      'urn:oid:2.49.0.1.840.0.478df6166ade7585f4aed605340188fa5f655ff1.002.1',
    ]);
    expect(textOf(superseded)).toMatch(/\*\*Message sent:\*\* Fri, Oct 16.* 1:14 AM CDT \|/);

    // The chain ends where NWS retention does.
    const aged = await runToolContract(tools.getAlertTool, {
      alert_id: prior.references[0]!.identifier,
    });
    expect(aged.isError).toBe(true);
    expect(
      (aged.structuredContent as { error: { data?: { reason?: string } } }).error.data?.reason,
    ).toBe('alert_not_found');

    expect(http.calls.map((c) => c.request.url)).toEqual([
      `${API}/alerts/${CURRENT_ALERT_ID}`,
      `${API}/alerts/${SUPERSEDED_ALERT_ID}`,
      `${API}/alerts/${olderId}`,
    ]);
  });

  it('fails a well-formed ID NWS answers with 404 as alert_not_found with the declared recovery', async () => {
    http.route(route(`${API}/alerts/${AGED_OUT_ALERT_ID}`, invalidAlertProblem, 404));

    const result = await runToolContract(tools.getAlertTool, { alert_id: AGED_OUT_ALERT_ID });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: {
        code: number;
        message: string;
        data?: { reason?: string; recovery?: { hint?: string } };
      };
    };
    const message = `NWS has no alert "${AGED_OUT_ALERT_ID}": the ID does not exist, or the message is past the ~7 days NWS keeps alerts.`;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('alert_not_found');
    expect(error.data?.recovery?.hint).toBe(RECOVERY);
    expect(error.message).toBe(message);
    const text = textOf(result);
    expect(text).toContain(message);
    expect(text).toContain(`Recovery: ${RECOVERY}`);
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    '',
    '   ',
    '../alerts/active',
    `${API}/alerts/${CURRENT_ALERT_ID}`,
    CURRENT_ALERT_ID.toUpperCase(),
  ])('fails %j as alert_not_found before any request', async (alertId) => {
    const result = await runToolContract(tools.getAlertTool, { alert_id: alertId });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: {
        code: number;
        message: string;
        data?: { reason?: string; recovery?: { hint?: string } };
      };
    };
    const message =
      'alert_id is not an NWS alert ID. NWS alert IDs read "urn:oid:2.49.0.1.840.0." followed by a 40-character lowercase hex hash, a 3-digit segment, and a version (e.g., "urn:oid:2.49.0.1.840.0.654087301e4bfcbe71d24494c26a965e54d3a1ad.001.1").';
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('alert_not_found');
    expect(error.data?.recovery?.hint).toBe(RECOVERY);
    expect(error.message).toBe(message);
    expect(textOf(result)).toContain(message);
    expect(http.calls).toHaveLength(0);
  });

  it('requests an ID padded with whitespace trimmed', async () => {
    http.route(route(`${API}/alerts/${CURRENT_ALERT_ID}`, currentAlertFeature));

    const result = await runToolContract(tools.getAlertTool, {
      alert_id: `  ${CURRENT_ALERT_ID}\n`,
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as AlertPayload).alert.id).toBe(CURRENT_ALERT_ID);
    expect(http.calls.map((c) => c.request.url)).toEqual([`${API}/alerts/${CURRENT_ALERT_ID}`]);
  });

  it('renders a sparse heartbeat message without inventing absent fields', async () => {
    http.route(route(`${API}/alerts/${KEEPALIVE_ALERT_ID}`, keepaliveAlertFeature));

    const result = await runToolContract(tools.getAlertTool, { alert_id: KEEPALIVE_ALERT_ID });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { alert: Record<string, unknown> }).alert).toMatchObject({
      headline: null,
      onset: null,
      ends: null,
      references: [],
      status: 'Test',
    });
    const text = textOf(result);
    expect(text).toContain('### Test Message');
    expect(text).toContain('**Message type:** Alert | **Status:** Test');
    expect(text).toContain('**Zones:** MDC031 (county)');
    expect(text).not.toContain('**Hazard onset:**');
    expect(text).not.toContain('**Hazard ends:**');
    expect(text).not.toContain('**Supersedes:**');
    expect(text).not.toContain('null');
  });

  it('names nws_get_alert on the search tool’s id and references fields', () => {
    const alertShape = tools.searchAlertsTool.output.shape.alerts.element.shape;

    expect(alertShape.id.description).toContain('nws_get_alert');
    expect(alertShape.references.description).toContain('nws_get_alert');
    expect(alertShape.references.element.shape.identifier.description).toContain('nws_get_alert');
  });
});
