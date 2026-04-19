/**
 * @fileoverview Tests for nws_search_alerts tool.
 * @module tests/tools/search-alerts
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertSearchResult } from '@/services/nws/nws-service.js';

const mockSearchAlerts = vi.fn<() => Promise<AlertSearchResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ searchAlerts: mockSearchAlerts }),
}));

const { searchAlertsTool } = await import('@/mcp-server/tools/definitions/search-alerts.tool.js');

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
      onset: '2026-04-03T12:00:00-07:00',
      expires: '2026-04-04T00:00:00-07:00',
      senderName: 'NWS Seattle WA',
      affectedZones: ['WAZ558'],
    },
  ],
};

describe('nws_search_alerts', () => {
  beforeEach(() => {
    mockSearchAlerts.mockReset();
  });

  it('parses input with area filter', () => {
    const input = searchAlertsTool.input.parse({ area: 'WA' });
    expect(input.area).toBe('WA');
    expect(input.status).toBe('Actual');
  });

  it('returns alerts with count and filters', async () => {
    mockSearchAlerts.mockResolvedValueOnce(alertResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({ area: 'WA' });
    const result = await searchAlertsTool.handler(input, ctx);

    expect(result.count).toBe(1);
    expect(result.shown).toBe(1);
    expect(result.filters).toContain('area=WA');
    expect(result.alerts[0].event).toBe('Wind Advisory');
    expect(result.alerts[0].instruction).toBe('Secure outdoor objects.');
  });

  it('returns zero count for no alerts', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({});
    const result = await searchAlertsTool.handler(input, ctx);

    expect(result.count).toBe(0);
    expect(result.shown).toBe(0);
    expect(result.filters).toBe('national (no filters)');
    expect(result.alerts).toHaveLength(0);
  });

  it('validates point format', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({ point: '999,999' });
    const result = searchAlertsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    await expect(result).rejects.toThrow('Invalid point');
  });

  it('validates area code', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({ area: 'zz' });
    const result = searchAlertsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    await expect(result).rejects.toThrow('Invalid area code');
  });

  it('normalizes empty-string location filters away before calling the service', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({ area: '', point: '', zone: '' });
    const result = await searchAlertsTool.handler(input, ctx);

    expect(result.filters).toBe('national (no filters)');
    expect(mockSearchAlerts).toHaveBeenCalledWith(
      expect.objectContaining({
        area: undefined,
        point: undefined,
        zone: undefined,
      }),
      ctx,
    );
  });

  it('rejects mutually exclusive area and point filters before calling the service', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({ area: 'TX', point: '32.7767,-96.7970' });
    const result = searchAlertsTool.handler(input, ctx);

    await expect(result).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
    await expect(result).rejects.toThrow('area, point, and zone are mutually exclusive');
    expect(mockSearchAlerts).not.toHaveBeenCalled();
  });

  it('ignores whitespace-only location filters when another real filter is present', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({ area: 'TX', zone: '   ' });
    await searchAlertsTool.handler(input, ctx);

    expect(mockSearchAlerts).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'TX',
        zone: undefined,
      }),
      ctx,
    );
  });

  it('passes all filter params to service', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test' });
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

    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({ area: ' wa ' });
    await searchAlertsTool.handler(input, ctx);

    expect(mockSearchAlerts).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'WA',
      }),
      ctx,
    );
  });

  it('includes certainty and non-default status in the filter summary', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({
      certainty: ['Observed'],
      status: 'Test',
    });
    const result = await searchAlertsTool.handler(input, ctx);

    expect(result.filters).toContain('certainty=Observed');
    expect(result.filters).toContain('status=Test');
  });

  describe('format', () => {
    it('renders helpful guidance for empty results', () => {
      const blocks = searchAlertsTool.format!({
        count: 0,
        shown: 0,
        filters: 'area=WA',
        alerts: [],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('No active alerts found');
      expect(text).toContain('area=WA');
      expect(text).toContain('broaden');
    });

    it('renders alert details', () => {
      const blocks = searchAlertsTool.format!({
        count: 1,
        shown: 1,
        filters: 'area=WA',
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
            onset: '2026-04-03T12:00:00Z',
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

    it('renders affected zones when present', () => {
      const blocks = searchAlertsTool.format!({
        count: 1,
        shown: 1,
        filters: 'area=WA',
        alerts: [
          {
            ...alertResult.alerts[0],
            affectedZones: ['WAZ558', 'WAC033'],
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('**Zones:** WAZ558, WAC033');
    });

    it('labels expires as "Message valid until" rather than "Expires" (regression: issue #7)', () => {
      // The CAP `expires` field is the message TTL, not the hazard end. Render
      // it with a label that reflects that — flat "Expires" misleads readers
      // when the message refreshes before the hazard begins.
      const blocks = searchAlertsTool.format!({
        count: 1,
        shown: 1,
        filters: 'event=Flood Watch',
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
            onset: '2026-04-20T07:00:00-05:00', // Mon 7 AM CDT — hazard begins later
            expires: '2026-04-19T18:45:00-05:00', // Sun 6:45 PM CDT — message refreshes earlier
            senderName: 'NWS Milwaukee/Sullivan WI',
            affectedZones: ['WIZ046'],
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

    it('renders alert times with a named US zone when affectedZones are present (regression: issue #8)', () => {
      const blocks = searchAlertsTool.format!({
        count: 1,
        shown: 1,
        filters: 'area=WA',
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
            onset: '2026-07-04T15:00:00Z', // 8:00 AM PDT
            expires: '2026-07-04T20:00:00Z', // 1:00 PM PDT
            senderName: 'NWS Seattle WA',
            affectedZones: ['WAZ558'],
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
        count: 1,
        shown: 1,
        filters: 'event=Marine Warning',
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
            onset: '2026-04-19T15:00:00-04:00',
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
        count: 1,
        shown: 1,
        filters: 'area=OK',
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
            onset: '2026-07-04T19:00:00Z', // 2:00 PM CDT
            expires: '2026-07-04T20:00:00Z',
            senderName: 'NWS Norman OK',
            affectedZones: ['OKC027'],
          },
        ],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('CDT');
      expect(text).not.toContain('UTC-');
    });

    it('shows truncation notice when capped', () => {
      const blocks = searchAlertsTool.format!({
        count: 50,
        shown: 25,
        filters: 'national (no filters)',
        alerts: [],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('25 more alerts not shown');
    });
  });
});
