/**
 * @fileoverview Tests for nws_get_zone_forecast tool.
 * @module tests/tools/get-zone-forecast
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZoneForecastResult } from '@/services/nws/nws-service.js';
import {
  lateEveningZoneForecastResponse,
  midnightHourZoneForecastResponse,
  noonHourZoneForecastResponse,
} from '../fixtures/nws-responses.js';

const mockGetZoneForecast = vi.fn<() => Promise<ZoneForecastResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ getZoneForecast: mockGetZoneForecast }),
}));

const { getZoneForecastTool } = await import(
  '@/mcp-server/tools/definitions/get-zone-forecast.tool.js'
);

/**
 * The tool's `format()` parameter: the same fields as `ZoneForecastResult` but with a
 * mutable `periods` array, so one fixture serves both the service mock and `format()`.
 */
type ZoneForecastOutput = Parameters<NonNullable<typeof getZoneForecastTool.format>>[0];

const zoneForecastResult: ZoneForecastOutput = {
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

  it('rejects whitespace-only zone_id', () => {
    expect(() => getZoneForecastTool.input.parse({ zone_id: '   ' })).toThrow();
  });

  it('returns zone forecast with periods', async () => {
    mockGetZoneForecast.mockResolvedValueOnce(zoneForecastResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getZoneForecastTool.errors });
    const input = getZoneForecastTool.input.parse({ zone_id: 'WAZ315' });
    const result = await getZoneForecastTool.handler(input, ctx);

    expect(result.zoneId).toBe('WAZ315');
    expect(result.updated).toBe('2026-05-30T02:36:00-07:00');
    expect(result.periods).toHaveLength(2);
    expect(result.periods[0]!.name).toBe('Today');
    expect(result.periods[0]!.number).toBe(1);
    expect(result.periods[0]!.detailedForecast).toContain('Highs in the lower to mid 60s');
    expect(result.periods[1]!.name).toBe('Tonight');
  });

  it('sets enrichment periodCount', async () => {
    mockGetZoneForecast.mockResolvedValueOnce(zoneForecastResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getZoneForecastTool.errors });
    const input = getZoneForecastTool.input.parse({ zone_id: 'WAZ315' });
    await getZoneForecastTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.periodCount).toBe(2);
  });

  it('uppercases zone_id before passing to service', async () => {
    mockGetZoneForecast.mockResolvedValueOnce(zoneForecastResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getZoneForecastTool.errors });
    const input = getZoneForecastTool.input.parse({ zone_id: 'waz315' });
    await getZoneForecastTool.handler(input, ctx);

    expect(mockGetZoneForecast).toHaveBeenCalledWith('WAZ315', ctx);
  });

  it('points zone-code discovery at the forecast-typed affectedZones entries (issue #31)', () => {
    // The old text named affectedZones wholesale, so a caller following it could
    // pick a county entry that this tool categorically cannot serve.
    const zoneNotFound = getZoneForecastTool.errors!.find((e) => e.reason === 'zone_not_found')!;

    expect(zoneNotFound.recovery).toContain('affectedZones');
    expect(zoneNotFound.recovery).toMatch(/type.*forecast/i);
    expect(getZoneForecastTool.description).toMatch(/type.*forecast/i);
  });

  it('routes fire-typed affectedZones entries to the office FWF (issue #67)', () => {
    const zoneNotFound = getZoneForecastTool.errors!.find((e) => e.reason === 'zone_not_found')!;

    for (const text of [zoneNotFound.recovery, getZoneForecastTool.description]) {
      expect(text).toContain('nws_get_office_discussion');
      expect(text).toContain('product_type "FWF"');
      expect(text).toContain('the alert\'s "office" field');
      // County entries still have no zone forecast; fire entries are no longer called product-less.
      expect(text).toMatch(/"county" have no (text )?forecast/);
      expect(text).not.toMatch(/"fire" have no/);
      expect(text).not.toContain('cwa');
    }
  });

  it('names the marine zone families that have a text forecast and those that have none (issue #82)', () => {
    const marine = getZoneForecastTool.errors!.find(
      (e) => e.reason === 'marine_forecast_unsupported',
    )!;

    expect(marine.recovery).toBe(
      'Use nws_search_alerts with this zone code for marine hazards, or nws_get_forecast with coordinates on nearby land for a land forecast. Coastal zones starting AMZ, ANZ, GMZ, PHZ, or PZZ usually have a text forecast; Great Lakes, most Alaska, Guam, American Samoa, and offshore zones have none.',
    );
    expect(getZoneForecastTool.description).toContain(
      'Marine zones vary by family: coastal zones on an ocean coast, bay, or sound (codes starting AMZ, ANZ, GMZ, PHZ, or PZZ, e.g., "PZZ251") usually serve a text forecast of wind and seas, while Great Lakes, most Alaska, Guam, American Samoa, and offshore zones (e.g., "GMZ056") have none.',
    );
    expect(getZoneForecastTool.description).not.toContain('many coastal zones');
  });

  it('propagates zone_not_found error for invalid zone', async () => {
    mockGetZoneForecast.mockRejectedValueOnce(
      new Error('Zone "WAZ999" not found or has no forecast'),
    );

    const ctx = createMockContext({ tenantId: 'test', errors: getZoneForecastTool.errors });
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
      const sparse: ZoneForecastOutput = {
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

describe('nws_get_zone_forecast — updated read 12 hours off (issue #78)', () => {
  const { periods } = midnightHourZoneForecastResponse.properties;
  const moved = (sent: string, direction: 'back' | 'forward', updated: string) =>
    `NWS sent updated as ${sent}, 12 hours off: NWS misreads the 12 o'clock hour of the issuance time it takes updated from. Moved ${direction} 12 hours to ${updated}.`;
  const untrusted = (sent: string) =>
    `NWS sent updated as ${sent}, later than this response, so it cannot be trusted as the forecast's update time; it is returned as sent.`;

  /** Runs the tool with the clock at `now` on a forecast whose `updated` NWS sent as `sent`. */
  const callAt = async (now: string, sent: string) => {
    vi.setSystemTime(new Date(now));
    mockGetZoneForecast.mockResolvedValueOnce({ zoneId: 'TXZ211', updated: sent, periods });
    const result = await runToolContract(getZoneForecastTool, { zone_id: 'TXZ211' });
    expect(result.isError).toBeFalsy();
    return {
      structured: result.structuredContent as { notice?: string; updated: string },
      text: result.content.map((block) => ('text' in block ? block.text : '')).join('\n'),
    };
  };

  /** `updated` and the notice on both surfaces. */
  const expectServed = async (
    now: string,
    sent: string,
    updated: string,
    notice: string | undefined,
  ) => {
    const { structured, text } = await callAt(now, sent);
    expect(structured.updated).toBe(updated);
    expect(structured.notice).toBe(notice);
    expect(text).toContain(`**Updated:** ${updated}\n`);
    if (notice) expect(text).toContain(`> ${notice}`);
    else expect(text).not.toContain('NWS sent updated');
  };

  beforeEach(() => {
    mockGetZoneForecast.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    // A future value at hour 12 or 00 moves back 12 hours.
    [
      '2026-11-11T13:40:00Z',
      '2026-11-11T12:22:00-06:00',
      '2026-11-11T00:22:00-06:00',
      moved('2026-11-11T12:22:00-06:00', 'back', '2026-11-11T00:22:00-06:00'),
    ],
    [
      '2026-11-11T19:00:00Z',
      '2026-11-12T00:22:00-06:00',
      '2026-11-11T12:22:00-06:00',
      moved('2026-11-12T00:22:00-06:00', 'back', '2026-11-11T12:22:00-06:00'),
    ],
    // A past hour-00 value moves forward 12 hours when that is not after now.
    [
      '2026-11-11T19:00:00Z',
      '2026-11-11T00:22:00-06:00',
      '2026-11-11T12:22:00-06:00',
      moved('2026-11-11T00:22:00-06:00', 'forward', '2026-11-11T12:22:00-06:00'),
    ],
    ['2026-11-11T07:00:00Z', '2026-11-11T00:22:00-06:00', '2026-11-11T00:22:00-06:00', undefined],
    // A past hour-12 value is a faithful reading.
    ['2026-11-11T19:00:00Z', '2026-11-11T12:22:00-06:00', '2026-11-11T12:22:00-06:00', undefined],
    // Any other future value stays, flagged; any other past one stays.
    [
      '2026-11-11T13:40:00Z',
      '2026-11-11T15:10:00-06:00',
      '2026-11-11T15:10:00-06:00',
      untrusted('2026-11-11T15:10:00-06:00'),
    ],
    ['2026-11-11T13:40:00Z', '2026-11-11T05:47:00-06:00', '2026-11-11T05:47:00-06:00', undefined],
  ])('at %s serves NWS updated %s as %s', expectServed);

  it.each([
    // The future side ends at now: an hour-12 value at now is past, and a faithful reading.
    ['2026-11-11T18:21:59.999Z', '2026-11-11T00:22:00-06:00'],
    ['2026-11-11T18:22:00.000Z', '2026-11-11T12:22:00-06:00'],
  ])('at %s serves NWS updated 2026-11-11T12:22:00-06:00 as %s', async (now, updated) => {
    const sent = '2026-11-11T12:22:00-06:00';
    await expectServed(
      now,
      sent,
      updated,
      updated === sent ? undefined : moved(sent, 'back', updated),
    );
  });

  it.each([
    // The forward move holds once the moved time is not after now.
    ['2026-11-11T18:21:59.999Z', '2026-11-11T00:22:00-06:00'],
    ['2026-11-11T18:22:00.000Z', '2026-11-11T12:22:00-06:00'],
  ])('at %s serves NWS updated 2026-11-11T00:22:00-06:00 as %s', async (now, updated) => {
    const sent = '2026-11-11T00:22:00-06:00';
    await expectServed(
      now,
      sent,
      updated,
      updated === sent ? undefined : moved(sent, 'forward', updated),
    );
  });

  it.each([
    // Across a year boundary, in a positive offset, and with fractional seconds kept.
    ['2026-12-31T20:00:00Z', '2027-01-01T00:05:00-10:00', '2026-12-31T12:05:00-10:00'],
    ['2026-11-11T01:00:00Z', '2026-11-11T12:31:00+10:00', '2026-11-11T00:31:00+10:00'],
    ['2026-11-11T13:40:00Z', '2026-11-11T12:22:00.000-06:00', '2026-11-11T00:22:00.000-06:00'],
    ['2026-11-11T08:00:00Z', '2026-11-11T12:22:00Z', '2026-11-11T00:22:00Z'],
  ])('at %s moves NWS updated %s back to %s in its own offset', async (now, sent, updated) => {
    await expectServed(now, sent, updated, moved(sent, 'back', updated));
  });

  it('passes an unparseable updated through with no notice', async () => {
    await expectServed('2026-11-11T13:40:00Z', 'not a time', 'not a time', undefined);
  });

  it.each(['Asia/Tokyo', 'America/Anchorage'])(
    'corrects the same way with the host clock in %s',
    async (zone) => {
      vi.stubEnv('TZ', zone);
      // The switch took effect: the host's local hour of 13:40Z differs by zone.
      expect(new Date('2026-11-11T13:40:00Z').getHours()).toBe(zone === 'Asia/Tokyo' ? 22 : 4);
      await expectServed(
        '2026-11-11T13:40:00Z',
        '2026-11-11T12:22:00-06:00',
        '2026-11-11T00:22:00-06:00',
        moved('2026-11-11T12:22:00-06:00', 'back', '2026-11-11T00:22:00-06:00'),
      );
    },
  );

  it('corrects the captured TXZ211 midnight-hour forecast to its header instant', async () => {
    vi.setSystemTime(new Date('2026-11-11T13:40:00Z'));
    const { updated: sent, periods: captured } = midnightHourZoneForecastResponse.properties;
    mockGetZoneForecast.mockResolvedValueOnce({
      zoneId: 'TXZ211',
      updated: sent,
      periods: captured,
    });
    const result = await runToolContract(getZoneForecastTool, { zone_id: 'TXZ211' });

    // Header "1222 AM CST Wed Nov 11 2026".
    expect(result.structuredContent).toEqual({
      zoneId: 'TXZ211',
      updated: '2026-11-11T00:22:00-06:00',
      periods: captured,
      periodCount: 2,
      notice: moved(sent, 'back', '2026-11-11T00:22:00-06:00'),
    });
  });

  it('leaves the captured WYZ118 late-evening forecast as sent', async () => {
    vi.setSystemTime(new Date('2026-11-11T13:40:00Z'));
    const { updated: sent, periods: captured } = lateEveningZoneForecastResponse.properties;
    mockGetZoneForecast.mockResolvedValueOnce({
      zoneId: 'WYZ118',
      updated: sent,
      periods: captured,
    });
    const result = await runToolContract(getZoneForecastTool, { zone_id: 'WYZ118' });

    // Header "1132 PM MST Tue Nov 10 2026".
    expect(result.structuredContent).toEqual({
      zoneId: 'WYZ118',
      updated: '2026-11-10T23:32:00-07:00',
      periods: captured,
      periodCount: 2,
    });
  });

  it('leaves the captured PAZ064 noon-hour forecast at its header instant', async () => {
    // Captured three minutes after issuance: a past hour-12 value is a correct reading.
    vi.setSystemTime(new Date('2026-11-11T17:03:30Z'));
    const { updated: sent, periods: captured } = noonHourZoneForecastResponse.properties;
    mockGetZoneForecast.mockResolvedValueOnce({
      zoneId: 'PAZ064',
      updated: sent,
      periods: captured,
    });
    const result = await runToolContract(getZoneForecastTool, { zone_id: 'PAZ064' });

    // Header "1200 PM EST Wed Nov 11 2026".
    expect(result.structuredContent).toEqual({
      zoneId: 'PAZ064',
      updated: '2026-11-11T12:00:00-05:00',
      periods: captured,
      periodCount: 2,
    });
  });
});
