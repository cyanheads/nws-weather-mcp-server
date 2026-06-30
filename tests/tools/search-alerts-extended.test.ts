/**
 * @fileoverview Extended tests for nws_search_alerts: point validation edge cases,
 * zone filter, marine area codes, event filtering, caps.
 * @module tests/tools/search-alerts-extended
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertSearchResult } from '@/services/nws/nws-service.js';

const mockSearchAlerts = vi.fn<() => Promise<AlertSearchResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ searchAlerts: mockSearchAlerts }),
}));

const { searchAlertsTool } = await import('@/mcp-server/tools/definitions/search-alerts.tool.js');

function makeAlert(overrides: Partial<AlertSearchResult['alerts'][0]> = {}) {
  return {
    id: 'urn:oid:test',
    event: 'Tornado Warning',
    headline: 'Tornado Warning in effect',
    description: 'Take shelter.',
    instruction: 'Move to interior room.',
    severity: 'Extreme',
    urgency: 'Immediate',
    certainty: 'Observed',
    areaDesc: 'Cleveland County',
    onset: '2026-04-03T20:00:00Z',
    ends: '2026-04-03T21:00:00Z',
    expires: '2026-04-03T22:00:00Z',
    senderName: 'NWS Norman OK',
    affectedZones: ['OKZ027'],
    ...overrides,
  };
}

describe('nws_search_alerts extended', () => {
  beforeEach(() => {
    mockSearchAlerts.mockReset();
  });

  describe('point validation edge cases', () => {
    it('accepts boundary point +90,+180', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ point: '90,180' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ point: '90,180' }),
        ctx,
      );
    });

    it('accepts boundary point -90,-180', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ point: '-90,-180' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ point: '-90,-180' }),
        ctx,
      );
    });

    it('rejects point with three coordinates', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '47.6,-122.3,0' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_point' },
      });
    });

    it('rejects point with only one coordinate', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '47.6' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_point' },
      });
    });

    it('rejects point with non-numeric values', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: 'abc,def' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_point' },
      });
    });

    it('rejects latitude outside -90..90 in point', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '99.0,-122.3' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_point' },
      });
    });

    it('rejects longitude outside -180..180 in point', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '47.6,999.0' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_point' },
      });
    });

    it('rejects a trailing-comma point with an empty segment before upstream (regression: issue #20)', async () => {
      // "47.6," used to coerce to [47.6, 0] via .split(',').map(Number) and pass,
      // then trip the upstream regex 400. It must now fail locally as invalid_point.
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '47.6,' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_point' },
      });
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('salvages a point with whitespace after the comma (regression: issue #20)', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ point: '47.6, -122.3' });
      await searchAlertsTool.handler(input, ctx);

      // Internal whitespace collapses to the NWS-accepted form before the call.
      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ point: '47.6,-122.3' }),
        ctx,
      );
    });
  });

  describe('zone filter', () => {
    it('passes zone parameter to service', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ zone: 'WAZ558' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ zone: 'WAZ558' }),
        ctx,
      );
    });

    it('rejects mutually exclusive zone and area', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: 'WAZ558', area: 'WA' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'mutually_exclusive_filters' },
      });
    });

    it('rejects mutually exclusive zone and point', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: 'WAZ558', point: '47.6,-122.3' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'mutually_exclusive_filters' },
      });
    });

    it('includes zone in enrichment filter summary', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ zone: 'WAZ558' });
      await searchAlertsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.appliedFilters).toContain('zone=WAZ558');
    });

    it('uppercases a lowercase zone before passing it to the service (regression: issue #20)', async () => {
      // "waz315" used to reach NWS verbatim and trip the upstream zone-code regex;
      // it must be upper-cased like the sibling zone tools.
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ zone: 'waz315' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ zone: 'WAZ315' }),
        ctx,
      );
      expect(getEnrichment(ctx).appliedFilters).toContain('zone=WAZ315');
    });
  });

  describe('marine area codes', () => {
    it('accepts valid marine area code PZ', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ area: 'PZ' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(expect.objectContaining({ area: 'PZ' }), ctx);
    });

    it('accepts valid marine area code GM', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ area: 'gm' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(expect.objectContaining({ area: 'GM' }), ctx);
    });

    it('rejects invalid marine-like code', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ area: 'XX' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_area_code' },
      });
    });
  });

  describe('event filtering', () => {
    it('passes event filters to service for server-side filtering', async () => {
      mockSearchAlerts.mockResolvedValueOnce({
        alerts: [makeAlert({ event: 'Tornado Warning' })],
      });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ event: ['tornado'] });
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].event).toBe('Tornado Warning');
    });

    it('includes event in enrichment filter summary', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ event: ['tornado'] });
      await searchAlertsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.appliedFilters).toContain('event=tornado');
    });
  });

  describe('alert cap at 25', () => {
    it('caps output at 25 alerts when upstream returns more', async () => {
      const manyAlerts = Array.from({ length: 30 }, (_, i) =>
        makeAlert({ id: `urn:test:${i}`, event: 'Wind Advisory' }),
      );
      mockSearchAlerts.mockResolvedValueOnce({ alerts: manyAlerts });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({});
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts).toHaveLength(25);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(30);
      expect(enrichment.shownCount).toBe(25);
    });

    it('returns all alerts when count is under the cap', async () => {
      const alerts = [makeAlert(), makeAlert({ id: 'urn:test:2', event: 'Flood Watch' })];
      mockSearchAlerts.mockResolvedValueOnce({ alerts });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({});
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts).toHaveLength(2);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(2);
      expect(enrichment.shownCount).toBe(2);
    });
  });

  describe('caller-controlled limit (issue #21)', () => {
    it('slices to the requested limit while reporting the full match count', async () => {
      const manyAlerts = Array.from({ length: 30 }, (_, i) =>
        makeAlert({ id: `urn:test:${i}`, event: 'Wind Advisory' }),
      );
      mockSearchAlerts.mockResolvedValueOnce({ alerts: manyAlerts });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ limit: 3 });
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts).toHaveLength(3);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(30); // full matched count, before the limit
      expect(enrichment.shownCount).toBe(3); // the slice
    });

    it('returns all matches when the limit exceeds the match count', async () => {
      const alerts = [makeAlert(), makeAlert({ id: 'urn:test:2', event: 'Flood Watch' })];
      mockSearchAlerts.mockResolvedValueOnce({ alerts });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ limit: 10 });
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts).toHaveLength(2);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(2);
      expect(enrichment.shownCount).toBe(2);
    });

    it('keeps limit out of the applied-filters echo (it shapes the response, not the query)', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ limit: 5 });
      await searchAlertsTool.handler(input, ctx);

      expect(getEnrichment(ctx).appliedFilters).toBe('national (no filters)');
    });

    it('rejects limit below 1', () => {
      expect(() => searchAlertsTool.input.parse({ limit: 0 })).toThrow();
    });

    it('rejects limit above the 25-alert cap', () => {
      expect(() => searchAlertsTool.input.parse({ limit: 26 })).toThrow();
    });
  });

  describe('null/optional alert fields', () => {
    it('handles null headline, instruction, onset, ends, expires', async () => {
      const alert = makeAlert({
        headline: null,
        instruction: null,
        onset: null,
        ends: null,
        expires: null,
      });
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [alert] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({});
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts[0].headline).toBeNull();
      expect(result.alerts[0].instruction).toBeNull();
      expect(result.alerts[0].onset).toBeNull();
      expect(result.alerts[0].ends).toBeNull();
      expect(result.alerts[0].expires).toBeNull();
    });

    it('format() omits onset/ends/expires lines when null', () => {
      const blocks = searchAlertsTool.format!({
        alerts: [
          {
            ...makeAlert({ onset: null, ends: null, expires: null }),
          },
        ],
      });
      const t = (blocks[0] as { type: 'text'; text: string }).text;
      expect(t).not.toContain('Hazard onset');
      expect(t).not.toContain('Hazard ends');
      expect(t).not.toContain('Message valid until');
    });
  });

  describe('severity/urgency/certainty filters in enrichment', () => {
    it('includes severity in enrichment filter summary', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ severity: ['Extreme', 'Severe'] });
      await searchAlertsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.appliedFilters).toContain('severity=Extreme, Severe');
    });

    it('includes urgency in enrichment filter summary', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test' });
      const input = searchAlertsTool.input.parse({ urgency: ['Immediate'] });
      await searchAlertsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.appliedFilters).toContain('urgency=Immediate');
    });
  });
});
