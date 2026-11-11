/**
 * @fileoverview Integer cursor-window validation shared by local paged tools, and the
 * invalid-cursor recovery each paged tool renders.
 * @module tests/tools/page-limit
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { validatePageWindow } from '@/mcp-server/tools/page-limit.js';

// A cursor these tools never minted fails before any NWS request.
vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => {
    throw new Error('An invalid cursor must fail before any NWS request.');
  },
}));

const { getForecastTool } = await import('@/mcp-server/tools/definitions/get-forecast.tool.js');
const { getObservationHistoryTool } = await import(
  '@/mcp-server/tools/definitions/get-observation-history.tool.js'
);
const { searchAlertsTool } = await import('@/mcp-server/tools/definitions/search-alerts.tool.js');

describe('validatePageWindow', () => {
  it.each([
    [0.5, 10],
    [0, 0.5],
    [Infinity, 10],
    [0, Infinity],
    [NaN, 10],
    [0, NaN],
  ])('rejects offset %s and limit %s', (offset, limit) => {
    expect(() => validatePageWindow(offset, limit, 'token', 'Restart without cursor.')).toThrow(
      expect.objectContaining({
        code: -32602,
        data: {
          cursor: 'token',
          reason: 'invalid_cursor',
          recovery: { hint: 'Restart without cursor.' },
        },
      }),
    );
  });
  it('accepts decoded integral windows, including past-end and over-cap values', () => {
    expect(() => validatePageWindow(9999, 1000, 'token', 'Restart without cursor.')).not.toThrow();
  });
});

describe('invalid-cursor recovery on every paged tool', () => {
  /** A fractional offset no tool mints. */
  const cursor = Buffer.from('{"offset":0.5,"limit":10}').toString('base64');

  it.each([
    [
      'nws_get_forecast',
      () => runToolContract(getForecastTool, { latitude: 47.6, longitude: -122.3, cursor }),
      'Omit cursor to start from the first period, or pass the nextCursor from the previous response unchanged.',
      'Recovery: Omit `cursor` to start from the first period, or pass the `nextCursor` from the previous response unchanged.',
    ],
    [
      'nws_search_alerts',
      () => runToolContract(searchAlertsTool, { cursor }),
      'Omit cursor and send the filters to start from the first page, or pass the nextCursor from the previous response unchanged.',
      'Recovery: Omit `cursor` and send the filters to start from the first page, or pass the `nextCursor` from the previous response unchanged.',
    ],
    [
      'nws_get_observation_history',
      () => runToolContract(getObservationHistoryTool, { station_id: 'KSEA', cursor }),
      'Omit cursor to start from the latest observation, or pass the nextCursor from the previous response unchanged.',
      'Recovery: Omit `cursor` to start from the latest observation, or pass the `nextCursor` from the previous response unchanged.',
    ],
  ] as const)(
    '%s sends the hint as plain text and renders its parameter names as code spans',
    async (_tool, run, hint, recoveryLine) => {
      const result = await run();
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_cursor', recovery: { hint } } },
      });
      expect(text).toContain(recoveryLine);
      expect(text).not.toContain('\\`');
    },
  );
});
