/**
 * @fileoverview Tests for nws_list_alert_types tool.
 * @module tests/tools/list-alert-types
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListAlertTypes = vi.fn<() => Promise<readonly string[]>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ listAlertTypes: mockListAlertTypes }),
}));

const { listAlertTypesTool } = await import(
  '@/mcp-server/tools/definitions/list-alert-types.tool.js'
);

const alertTypes = [
  'Wind Advisory',
  'Tornado Warning',
  'Flash Flood Watch',
  'Blizzard Warning',
  'Severe Thunderstorm Warning',
];

describe('nws_list_alert_types', () => {
  beforeEach(() => {
    mockListAlertTypes.mockReset();
  });

  it('accepts empty input', () => {
    const input = listAlertTypesTool.input.parse({});
    expect(input).toEqual({});
  });

  it('returns sorted event types with count', async () => {
    mockListAlertTypes.mockResolvedValueOnce(alertTypes);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = listAlertTypesTool.input.parse({});
    const result = await listAlertTypesTool.handler(input, ctx);

    expect(result.count).toBe(5);
    expect(result.eventTypes).toHaveLength(5);
    // Verify sorted alphabetically
    expect(result.eventTypes[0]).toBe('Blizzard Warning');
    expect(result.eventTypes[result.eventTypes.length - 1]).toBe('Wind Advisory');
  });

  it('handles empty types list', async () => {
    mockListAlertTypes.mockResolvedValueOnce([]);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = listAlertTypesTool.input.parse({});
    const result = await listAlertTypesTool.handler(input, ctx);

    expect(result.count).toBe(0);
    expect(result.eventTypes).toHaveLength(0);
  });

  describe('format', () => {
    it('renders comma-separated list', () => {
      const blocks = listAlertTypesTool.format!({
        count: 3,
        eventTypes: ['Blizzard Warning', 'Tornado Warning', 'Wind Advisory'],
      });
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('3 NWS Alert Event Types');
      expect(text).toContain('Tornado Warning');
      expect(text).toContain(', ');
    });
  });
});
