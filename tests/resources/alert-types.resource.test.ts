/**
 * @fileoverview Tests for nws://alert-types resource.
 * @module tests/resources/alert-types
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListAlertTypes = vi.fn<() => Promise<readonly string[]>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ listAlertTypes: mockListAlertTypes }),
}));

const { alertTypesResource } = await import(
  '@/mcp-server/resources/definitions/alert-types.resource.js'
);

const alertTypes = ['Blizzard Warning', 'Flash Flood Watch', 'Tornado Warning', 'Wind Advisory'];

describe('nws://alert-types resource', () => {
  beforeEach(() => {
    mockListAlertTypes.mockReset();
  });

  it('returns sorted event types with count', async () => {
    mockListAlertTypes.mockResolvedValueOnce(alertTypes);

    const ctx = createMockContext({ tenantId: 'test', uri: new URL('nws://alert-types') });
    const result = await alertTypesResource.handler({}, ctx);

    expect(result.count).toBe(4);
    expect(result.eventTypes).toHaveLength(4);
    expect(result.eventTypes[0]).toBe('Blizzard Warning');
  });

  it('list returns resource metadata', async () => {
    const listed = await alertTypesResource.list!();

    expect(listed.resources).toHaveLength(1);
    expect(listed.resources[0].uri).toBe('nws://alert-types');
    expect(listed.resources[0].mimeType).toBe('application/json');
  });
});
