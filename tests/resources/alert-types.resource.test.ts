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
    // The resource declares no `output` schema, so its handler is typed `unknown`.
    const result = (await alertTypesResource.handler({}, ctx)) as {
      count: number;
      eventTypes: string[];
    };

    expect(result.count).toBe(4);
    expect(result.eventTypes).toHaveLength(4);
    expect(result.eventTypes[0]).toBe('Blizzard Warning');
  });

  it('list returns resource metadata', async () => {
    // `list` receives the SDK's own request context, not a framework Context.
    // The listing ignores it, so pass an empty stand-in typed off the callback
    // itself rather than hand-rolling the SDK shape — that shape grows between
    // SDK majors, and a literal copy of it goes stale silently.
    type ListContext = Parameters<NonNullable<typeof alertTypesResource.list>>[0];
    const listed = await alertTypesResource.list!({} as ListContext);

    expect(listed.resources).toHaveLength(1);
    expect(listed.resources[0]!.uri).toBe('nws://alert-types');
    expect(listed.resources[0]!.mimeType).toBe('application/json');
  });
});
