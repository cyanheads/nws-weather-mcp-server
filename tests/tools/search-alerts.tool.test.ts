/**
 * @fileoverview Tests for nws_search_alerts tool.
 * @module tests/tools/search-alerts
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertSearchResult } from '@/services/nws/nws-service.js';

const mockSearchAlerts = vi.fn<() => Promise<AlertSearchResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ searchAlerts: mockSearchAlerts }),
}));

const { searchAlertsTool } = await import('@/mcp-server/tools/definitions/search-alerts.tool.js');

/**
 * CAP lifecycle defaults (issue #33). NWS populates all five on every active
 * alert, so every fixture below carries them; tests that assert on lifecycle
 * behavior override the fields they exercise.
 */
const lifecycle = {
  sent: '2026-04-03T05:00:00-07:00',
  effective: '2026-04-03T05:00:00-07:00',
  status: 'Actual',
  messageType: 'Alert',
  references: [] as { identifier: string; sent: string }[],
};

const alertResult: AlertSearchResult = {
  alerts: [
    {
      id: 'urn:oid:2.49.0.1.840.0.abc123',
      event: 'Wind Advisory',
      headline: 'Wind Advisory issued April 3',
      description: 'Strong winds expected.',
      instruction: 'Secure outdoor objects.',
      severity: 'Moderate',
      urgency: 'Expected',
      certainty: 'Likely',
      areaDesc: 'King County',
      ...lifecycle,
      onset: '2026-04-03T12:00:00-07:00',
      ends: '2026-04-03T18:00:00-07:00',
      expires: '2026-04-04T00:00:00-07:00',
      senderName: 'NWS Seattle WA',
      affectedZones: [{ code: 'WAZ558', type: 'forecast' }],
    },
  ],
};

/**
 * The tool's `format()` alert element: the same fields as the service `Alert`,
 * with mutable arrays, so one fixture serves both the service mock and `format()`.
 */
type AlertOutput = Parameters<NonNullable<typeof searchAlertsTool.format>>[0]['alerts'][number];

/** The shared alert in the shape `format()` accepts, with per-test overrides. */
function formatAlert(overrides: Partial<AlertOutput> = {}): AlertOutput {
  const alert = alertResult.alerts[0]!;
  return {
    ...alert,
    affectedZones: [...alert.affectedZones],
    references: [...alert.references],
    ...overrides,
  };
}

describe('nws_search_alerts', () => {
  beforeEach(() => {
    mockSearchAlerts.mockReset();
  });

  it('parses input with area filter', () => {
    const input = searchAlertsTool.input.parse({ area: 'WA' });
    expect(input.area).toBe('WA');
    expect(input.status).toBe('Actual');
  });

  it('returns alerts with enrichment counts and filters', async () => {
    mockSearchAlerts.mockResolvedValueOnce(alertResult);

    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({ area: 'WA' });
    const result = await searchAlertsTool.handler(input, ctx);

    expect(result.alerts[0]!.event).toBe('Wind Advisory');
    expect(result.alerts[0]!.instruction).toBe('Secure outdoor objects.');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.shown).toBe(1);
    expect(enrichment.appliedFilters).toContain('area=WA');
    expect(enrichment.notice).toBeUndefined();
  });

  it('populates enrichment notice and zero counts for no alerts', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({});
    const result = await searchAlertsTool.handler(input, ctx);

    expect(result.alerts).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.shown).toBe(0);
    expect(enrichment.appliedFilters).toBe('national (no filters)');
    expect(enrichment.notice).toContain('No active alerts matched');
  });

  it('validates point format', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({ point: '999,999' });
    const result = searchAlertsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_point' },
    });
    await expect(result).rejects.toThrow('Invalid point');
  });

  it('validates area code', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({ area: 'zz' });
    const result = searchAlertsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_area_code' },
    });
    await expect(result).rejects.toThrow('Invalid area code');
  });

  it('rejects explicitly blank location filters instead of widening to a national search', async () => {
    // A provided-but-blank filter used to collapse to undefined and run the
    // unfiltered national query, answering a different question than was asked.
    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({ area: '', point: '', zone: '' });
    const result = searchAlertsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'blank_location_filter',
        recovery: { hint: expect.stringContaining('Omit') },
      },
    });
    expect(mockSearchAlerts).not.toHaveBeenCalled();
  });

  it('rejects mutually exclusive area and point filters before calling the service', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({ area: 'TX', point: '32.7767,-96.7970' });
    const result = searchAlertsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'mutually_exclusive_filters' },
    });
    await expect(result).rejects.toThrow(
      'only one of area, point, zone, region_type, or region is allowed',
    );
    expect(mockSearchAlerts).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only location filter even when another real filter is present', async () => {
    // The blank zone used to be dropped silently, narrowing the search to area
    // alone with no signal that a requested filter was discarded.
    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({ area: 'TX', zone: '   ' });
    const result = searchAlertsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'blank_location_filter' },
    });
    await expect(result).rejects.toThrow('zone');
    expect(mockSearchAlerts).not.toHaveBeenCalled();
  });

  it('passes all filter params to service', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({
      area: 'OK',
      severity: ['Extreme'],
      urgency: ['Immediate'],
      event: ['tornado'],
    });
    await searchAlertsTool.handler(input, ctx);

    expect(mockSearchAlerts).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'OK',
        severity: ['Extreme'],
        urgency: ['Immediate'],
        event: ['tornado'],
        status: 'Actual',
      }),
      ctx,
    );
  });

  it('trims and normalizes area before passing filters to the service', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({ area: ' wa ' });
    await searchAlertsTool.handler(input, ctx);

    expect(mockSearchAlerts).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'WA',
      }),
      ctx,
    );
  });

  it('includes certainty and non-default status in the enrichment filter summary', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({
      certainty: ['Observed'],
      status: 'Test',
    });
    await searchAlertsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.appliedFilters).toContain('certainty=Observed');
    expect(enrichment.appliedFilters).toContain('status=Test');
  });

  describe('format', () => {
    it('renders fallback message for empty results', () => {
      const blocks = searchAlertsTool.format!({ alerts: [] });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No active alerts matched');
    });

    it('renders alert details', () => {
      const blocks = searchAlertsTool.format!({
        alerts: [
          {
            id: 'test',
            event: 'Tornado Warning',
            headline: 'Tornado Warning for King County',
            description: 'Take shelter immediately.',
            instruction: 'Move to interior room.',
            severity: 'Extreme',
            urgency: 'Immediate',
            certainty: 'Observed',
            areaDesc: 'King County',
            ...lifecycle,
            onset: '2026-04-03T12:00:00Z',
            ends: '2026-04-03T13:00:00Z',
            expires: '2026-04-03T14:00:00Z',
            senderName: 'NWS Seattle',
            affectedZones: [],
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Tornado Warning');
      expect(text).toContain('Extreme');
      expect(text).toContain('Take shelter');
      expect(text).toContain('Move to interior room');
    });

    it('renders affected zones with their type so forecast-eligible codes are identifiable (issue #31)', () => {
      // Both codes still render; each now carries the zone type that decides
      // whether nws_get_zone_forecast will accept it.
      const blocks = searchAlertsTool.format!({
        alerts: [
          formatAlert({
            affectedZones: [
              { code: 'WAZ558', type: 'forecast' },
              { code: 'WAC033', type: 'county' },
            ],
          }),
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Zones:** WAZ558 (forecast), WAC033 (county)');
    });

    it('renders a county-only alert without implying any code is forecast-eligible (issue #31)', () => {
      const blocks = searchAlertsTool.format!({
        alerts: [
          formatAlert({
            event: 'Severe Thunderstorm Warning',
            affectedZones: [{ code: 'WAC033', type: 'county' }],
          }),
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Zones:** WAC033 (county)');
      expect(text).not.toContain('(forecast)');
    });

    it('renders the CAP lifecycle fields alongside the hazard timing (issue #33)', () => {
      const blocks = searchAlertsTool.format!({
        alerts: [
          formatAlert({
            sent: '2026-04-03T05:00:00-07:00',
            effective: '2026-04-03T05:30:00-07:00',
            status: 'Actual',
            messageType: 'Alert',
            references: [],
          }),
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('**Message type:** Alert');
      expect(text).toContain('**Status:** Actual');
      expect(text).toContain('**Message sent:**');
      expect(text).toContain('**Message effective:**');
      // An original issuance supersedes nothing — no fabricated reference line.
      expect(text).not.toContain('**Supersedes:**');
    });

    it('renders superseded prior alerts on an Update message (issue #33)', () => {
      const blocks = searchAlertsTool.format!({
        alerts: [
          formatAlert({
            messageType: 'Update',
            references: [
              { identifier: 'urn:oid:prior.001.1', sent: '2026-04-03T04:00:00-07:00' },
              { identifier: 'urn:oid:prior.000.1', sent: '2026-04-03T03:00:00-07:00' },
            ],
          }),
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('**Message type:** Update');
      expect(text).toContain('**Supersedes:**');
      expect(text).toContain('urn:oid:prior.001.1');
      expect(text).toContain('urn:oid:prior.000.1');
    });

    it('keeps the lifecycle lines from displacing the hazard timing block (issues #7, #18, #33)', () => {
      const blocks = searchAlertsTool.format!({ alerts: [formatAlert()] });
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      // onset → ends → message TTL stays intact, with the lifecycle block after it.
      expect(text.indexOf('**Hazard onset:**')).toBeLessThan(text.indexOf('**Hazard ends:**'));
      expect(text.indexOf('**Hazard ends:**')).toBeLessThan(
        text.indexOf('**Message valid until:**'),
      );
      expect(text.indexOf('**Message valid until:**')).toBeLessThan(
        text.indexOf('**Message type:**'),
      );
    });

    it('labels expires as "Message valid until" rather than "Expires" (regression: issue #7)', () => {
      // The CAP `expires` field is the message TTL, not the hazard end. Render
      // it with a label that reflects that — flat "Expires" misleads readers
      // when the message refreshes before the hazard begins.
      const blocks = searchAlertsTool.format!({
        alerts: [
          {
            id: 'urn:test:1',
            event: 'Flood Watch',
            headline: 'Flood Watch in effect from Monday morning through Tuesday afternoon',
            description: 'Heavy rain expected.',
            instruction: null,
            severity: 'Moderate',
            urgency: 'Future',
            certainty: 'Possible',
            areaDesc: 'Green Lake WI',
            ...lifecycle,
            onset: '2026-04-20T07:00:00-05:00', // Mon 7 AM CDT — hazard begins later
            ends: '2026-04-21T15:00:00-05:00', // Tue 3 PM CDT — hazard ends
            expires: '2026-04-19T18:45:00-05:00', // Sun 6:45 PM CDT — message refreshes earlier
            senderName: 'NWS Milwaukee/Sullivan WI',
            affectedZones: [{ code: 'WIZ046', type: 'forecast' }],
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('**Message valid until:**');
      expect(text).toContain('**Hazard onset:**');
      // Old, misleading labels should be gone
      expect(text).not.toMatch(/^\*\*Expires:\*\*/m);
      expect(text).not.toMatch(/^\*\*Onset:\*\*/m);
    });

    it('renders the hazard end from the structured ends field, distinct from expires (regression: issue #18)', () => {
      // ends (hazard end) and expires (message TTL) are separate fields with
      // separate labels. A pre-issued alert can have expires fall before onset,
      // so ends is the only structured end-of-hazard signal.
      const blocks = searchAlertsTool.format!({
        alerts: [
          {
            id: 'urn:test:ends',
            event: 'Heat Advisory',
            headline: 'Heat Advisory until Wednesday evening',
            description: 'Dangerous heat.',
            instruction: null,
            severity: 'Moderate',
            urgency: 'Expected',
            certainty: 'Likely',
            areaDesc: 'King County',
            ...lifecycle,
            onset: '2026-06-22T11:00:00-07:00', // hazard begins Mon
            ends: '2026-06-24T23:00:00-07:00', // hazard ends Wed — after the message refresh
            expires: '2026-06-22T03:00:00-07:00', // message refresh, before onset
            senderName: 'NWS Seattle WA',
            affectedZones: [{ code: 'WAZ558', type: 'forecast' }],
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('**Hazard ends:**');
      expect(text).toContain('**Message valid until:**');
      // Ordering: onset → ends → message TTL
      expect(text.indexOf('**Hazard onset:**')).toBeLessThan(text.indexOf('**Hazard ends:**'));
      expect(text.indexOf('**Hazard ends:**')).toBeLessThan(
        text.indexOf('**Message valid until:**'),
      );
    });

    it('renders alert times with a named US zone when affectedZones are present (regression: issue #8)', () => {
      const blocks = searchAlertsTool.format!({
        alerts: [
          {
            id: 'urn:test:2',
            event: 'Wind Advisory',
            headline: 'Wind Advisory in effect',
            description: 'Strong winds.',
            instruction: null,
            severity: 'Moderate',
            urgency: 'Expected',
            certainty: 'Likely',
            areaDesc: 'King County',
            ...lifecycle,
            onset: '2026-07-04T15:00:00Z', // 8:00 AM PDT
            ends: '2026-07-04T18:00:00Z', // 11:00 AM PDT
            expires: '2026-07-04T20:00:00Z', // 1:00 PM PDT
            senderName: 'NWS Seattle WA',
            affectedZones: [{ code: 'WAZ558', type: 'forecast' }],
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      expect(text).toContain('PDT');
      // The numeric-offset fallback should NOT be used when a state-derived TZ exists
      expect(text).not.toContain('UTC-07:00');
      expect(text).not.toContain('UTC-08:00');
    });

    it('falls back to numeric offset when affectedZones cannot be resolved to a TZ', () => {
      const blocks = searchAlertsTool.format!({
        alerts: [
          {
            id: 'urn:test:3',
            event: 'Special Marine Warning',
            headline: 'Marine warning',
            description: 'Hazardous seas.',
            instruction: null,
            severity: 'Moderate',
            urgency: 'Expected',
            certainty: 'Likely',
            areaDesc: 'Open ocean',
            ...lifecycle,
            onset: '2026-04-19T15:00:00-04:00',
            ends: '2026-04-19T21:00:00-04:00',
            expires: '2026-04-19T21:00:00-04:00',
            senderName: 'NWS Marine',
            affectedZones: [], // no zones → no derivable TZ
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;

      // No state prefix to derive from → fall back to numeric offset
      expect(text).toContain('UTC-04:00');
    });

    it('uses CDT for central-zone state codes', () => {
      const blocks = searchAlertsTool.format!({
        alerts: [
          {
            id: 'urn:test:4',
            event: 'Tornado Warning',
            headline: 'Tornado',
            description: 'Take shelter.',
            instruction: null,
            severity: 'Extreme',
            urgency: 'Immediate',
            certainty: 'Observed',
            areaDesc: 'Cleveland County',
            ...lifecycle,
            onset: '2026-07-04T19:00:00Z', // 2:00 PM CDT
            ends: '2026-07-04T19:30:00Z', // 2:30 PM CDT
            expires: '2026-07-04T20:00:00Z',
            senderName: 'NWS Norman OK',
            affectedZones: [{ code: 'OKC027', type: 'county' }],
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('CDT');
      expect(text).not.toContain('UTC-');
    });
  });
});
