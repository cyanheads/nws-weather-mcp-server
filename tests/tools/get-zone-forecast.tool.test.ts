/**
 * @fileoverview Tests for nws_get_zone_forecast tool.
 * @module tests/tools/get-zone-forecast
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZoneForecastResult } from '@/services/nws/nws-service.js';

const mockGetZoneForecast = vi.fn<() => Promise<ZoneForecastResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ getZoneForecast: mockGetZoneForecast }),
}));

const { getZoneForecastTool } = await import(
  '@/mcp-server/tools/definitions/get-zone-forecast.tool.js'
);

const zoneForecastResult: ZoneForecastResult = {
  zoneId: 'WAZ315',
  updated: '2026-05-30T02:36:00-07:00',
  periods: [
    {
      number: 1,
      name: 'Today',
      detailedForecast:
        'Mostly cloudy in the morning then becoming mostly sunny. Highs in the lower to mid 60s. Light wind.',
    },
    {
      number: 2,
      name: 'Tonight',
      detailedForecast: 'Mostly cloudy. Lows in the upper 40s. South wind 5 to 10 mph.',
    },
  ],
};

describe('nws_get_zone_forecast', () => {
  beforeEach(() => {
    mockGetZoneForecast.mockReset();
  });

  it('parses valid zone_id input', () => {
    const input = getZoneForecastTool.input.parse({ zone_id: 'WAZ315' });
    expect(input.zone_id).toBe('WAZ315');
  });

  it('rejects empty zone_id', () => {
    expect(() => getZoneForecastTool.input.parse({ zone_id: '' })).toThrow();
  });

  it('returns zone forecast with periods', async () => {
    mockGetZoneForecast.mockResolvedValueOnce(zoneForecastResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getZoneForecastTool.input.parse({ zone_id: 'WAZ315' });
    const result = await getZoneForecastTool.handler(input, ctx);

    expect(result.zoneId).toBe('WAZ315');
    expect(result.updated).toBe('2026-05-30T02:36:00-07:00');
    expect(result.periods).toHaveLength(2);
    expect(result.periods[0].name).toBe('Today');
    expect(result.periods[0].number).toBe(1);
    expect(result.periods[0].detailedForecast).toContain('Highs in the lower to mid 60s');
    expect(result.periods[1].name).toBe('Tonight');
  });

  it('sets enrichment periodCount', async () => {
    mockGetZoneForecast.mockResolvedValueOnce(zoneForecastResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getZoneForecastTool.input.parse({ zone_id: 'WAZ315' });
    await getZoneForecastTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.periodCount).toBe(2);
  });

  it('uppercases zone_id before passing to service', async () => {
    mockGetZoneForecast.mockResolvedValueOnce(zoneForecastResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getZoneForecastTool.input.parse({ zone_id: 'waz315' });
    await getZoneForecastTool.handler(input, ctx);

    expect(mockGetZoneForecast).toHaveBeenCalledWith('WAZ315', ctx);
  });

  it('propagates zone_not_found error for invalid zone', async () => {
    mockGetZoneForecast.mockRejectedValueOnce(
      new Error('Zone "WAZ999" not found or has no forecast'),
    );

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getZoneForecastTool.input.parse({ zone_id: 'WAZ999' });
    await expect(getZoneForecastTool.handler(input, ctx)).rejects.toThrow('WAZ999');
  });

  describe('format', () => {
    it('renders zone ID, updated, and period forecasts with number', () => {
      const blocks = getZoneForecastTool.format!(zoneForecastResult);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('WAZ315');
      expect(text).toContain('2026-05-30T02:36:00-07:00');
      expect(text).toContain('Today');
      expect(text).toContain('Tonight');
      // period number must appear (format-parity)
      expect(text).toContain('1.');
      expect(text).toContain('2.');
      expect(text).toContain('Highs in the lower to mid 60s');
    });

    it('renders all periods for sparse payload (single period)', () => {
      const sparse: ZoneForecastResult = {
        zoneId: 'WAZ315',
        updated: '2026-05-30T00:00:00-07:00',
        periods: [{ number: 1, name: 'Today', detailedForecast: 'Sunny.' }],
      };
      const blocks = getZoneForecastTool.format!(sparse);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Sunny.');
    });
  });
});
