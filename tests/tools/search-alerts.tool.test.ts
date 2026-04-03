/**
 * @fileoverview Tests for nws_search_alerts tool.
 * @module tests/tools/search-alerts
 */

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
      affectedZones: ['https://api.weather.gov/zones/forecast/WAZ558'],
    },
  ],
};

describe('nws_search_alerts', () => {
  beforeEach(() => {
    mockSearchAlerts.mockReset();
  });

  it('parses input with default status', () => {
    const input = searchAlertsTool.input.parse({ area: 'WA' });
    expect(input.area).toBe('WA');
    expect(input.status).toBe('Actual');
  });

  it('returns alerts with count', async () => {
    mockSearchAlerts.mockResolvedValueOnce(alertResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({ area: 'WA' });
    const result = await searchAlertsTool.handler(input, ctx);

    expect(result.count).toBe(1);
    expect(result.alerts[0].event).toBe('Wind Advisory');
    expect(result.alerts[0].instruction).toBe('Secure outdoor objects.');
  });

  it('returns zero count for no alerts', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({});
    const result = await searchAlertsTool.handler(input, ctx);

    expect(result.count).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  it('passes all filter params to service', async () => {
    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({
      area: 'OK',
      severity: ['Extreme'],
      urgency: ['Immediate'],
      event: ['Tornado Warning'],
    });
    await searchAlertsTool.handler(input, ctx);

    expect(mockSearchAlerts).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'OK',
        severity: ['Extreme'],
        urgency: ['Immediate'],
        event: ['Tornado Warning'],
      }),
      ctx,
    );
  });

  describe('format', () => {
    it('renders "all clear" for empty results', () => {
      const blocks = searchAlertsTool.format!({ count: 0, alerts: [] });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('All clear');
    });

    it('renders alert details', () => {
      const blocks = searchAlertsTool.format!({
        count: 1,
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
  });
});
