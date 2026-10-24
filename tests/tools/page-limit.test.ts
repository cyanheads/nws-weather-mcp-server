/**
 * @fileoverview Integer cursor-window validation shared by local paged tools.
 * @module tests/tools/page-limit
 */
import { describe, expect, it } from 'vitest';
import { validatePageWindow } from '@/mcp-server/tools/page-limit.js';

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
