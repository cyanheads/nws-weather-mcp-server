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
