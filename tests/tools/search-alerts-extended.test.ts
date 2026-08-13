/**
 * @fileoverview Extended tests for nws_search_alerts: point validation edge cases,
 * zone filter, marine area codes, event filtering, caps.
 * @module tests/tools/search-alerts-extended
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertSearchResult } from '@/services/nws/nws-service.js';

const mockSearchAlerts = vi.fn<() => Promise<AlertSearchResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ searchAlerts: mockSearchAlerts }),
}));

const { searchAlertsTool } = await import('@/mcp-server/tools/definitions/search-alerts.tool.js');

/**
 * The tool's `format()` alert element: the same fields as the service `Alert` but with a
 * mutable `affectedZones` array, so one fixture serves both the service mock and `format()`.
 */
type AlertOutput = Parameters<NonNullable<typeof searchAlertsTool.format>>[0]['alerts'][number];

function makeAlert(overrides: Partial<AlertOutput> = {}): AlertOutput {
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
    sent: '2026-04-03T19:55:00Z',
    effective: '2026-04-03T19:55:00Z',
    onset: '2026-04-03T20:00:00Z',
    ends: '2026-04-03T21:00:00Z',
    expires: '2026-04-03T22:00:00Z',
    status: 'Actual',
    messageType: 'Alert',
    references: [],
    senderName: 'NWS Norman OK',
    affectedZones: [{ code: 'OKZ027', type: 'forecast' }],
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

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '90,180' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ point: '90,180' }),
        ctx,
      );
    });

    it('accepts boundary point -90,-180', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
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

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
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

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
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

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: 'WAZ558' });
      await searchAlertsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.appliedFilters).toContain('zone=WAZ558');
    });

    it('uppercases a lowercase zone before passing it to the service (regression: issue #20)', async () => {
      // "waz315" used to reach NWS verbatim and trip the upstream zone-code regex;
      // it must be upper-cased like the sibling zone tools.
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: 'waz315' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ zone: 'WAZ315' }),
        ctx,
      );
      expect(getEnrichment(ctx).appliedFilters).toContain('zone=WAZ315');
    });

    it('accepts a county zone code with the C infix', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: 'WAC033' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ zone: 'WAC033' }),
        ctx,
      );
    });
  });

  describe('zone shape validation (issue #20)', () => {
    it('rejects a malformed zone before the upstream call', async () => {
      // "not-a-zone" used to reach /alerts/active and return NWS's raw parameter
      // regex to the caller with no server-owned reason or recovery hint.
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: 'not-a-zone' });
      const result = searchAlertsTool.handler(input, ctx);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_zone',
          recovery: { hint: expect.stringContaining('WAZ558') },
        },
      });
      await expect(result).rejects.toThrow('Invalid zone');
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('rejects a well-formed zone whose 2-letter prefix is not a real area code', async () => {
      // QQZ123 satisfies a bare ^[A-Z]{2}[CZ]\d{3}$ but QQ is not in the NWS
      // prefix enumeration, so it leaks the same raw upstream regex.
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: 'QQZ123' });
      const result = searchAlertsTool.handler(input, ctx);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_zone' },
      });
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('rejects a zone with the wrong digit count', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: 'WAZ55' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_zone' },
      });
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('rejects a zone with an infix other than C or Z', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: 'WAX558' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_zone' },
      });
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('lets a well-formed zone with no matching upstream zone through to a clean empty search', async () => {
      // WAZ999 is a real prefix with no such zone: NWS answers 200 with zero
      // features. The local shape check must not turn that into an error.
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: 'WAZ999' });
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts).toHaveLength(0);
      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ zone: 'WAZ999' }),
        ctx,
      );
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(0);
      expect(enrichment.appliedFilters).toContain('zone=WAZ999');
      expect(enrichment.notice).toContain('No active alerts matched');
    });

    it('applies the shape check to the normalized value, so a padded lowercase zone is salvaged', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: '  waz558  ' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ zone: 'WAZ558' }),
        ctx,
      );
    });
  });

  describe('provided-but-empty filters (issue #30)', () => {
    it.each([
      ['area', { area: '   ' }],
      ['point', { point: '' }],
      ['zone', { zone: '   ' }],
    ] as const)('rejects a blank %s rather than running a national search', async (field, args) => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse(args);
      const result = searchAlertsTool.handler(input, ctx);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'blank_location_filter',
          recovery: { hint: expect.stringContaining('Omit') },
        },
      });
      await expect(result).rejects.toThrow(field);
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it.each(['event', 'severity', 'urgency', 'certainty'] as const)(
      'rejects an explicitly empty %s array',
      async (field) => {
        const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
        const input = searchAlertsTool.input.parse({ [field]: [] });
        const result = searchAlertsTool.handler(input, ctx);

        await expect(result).rejects.toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'empty_filter_array',
            recovery: { hint: expect.stringContaining('Omit') },
          },
        });
        await expect(result).rejects.toThrow(field);
        expect(mockSearchAlerts).not.toHaveBeenCalled();
      },
    );

    it('rejects an event array whose only entry is blank', async () => {
      // ["   "] used to survive the non-empty check, so appliedFilters echoed
      // `event=   ` for a term the service then discarded, matching every event.
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ event: ['   '] });
      const result = searchAlertsTool.handler(input, ctx);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'empty_filter_array' },
      });
      await expect(result).rejects.toThrow('blank');
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('keeps an event array with at least one real entry, dropping the blank terms from the echo', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ event: [' Tornado Warning ', '   '] });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ event: ['Tornado Warning'] }),
        ctx,
      );
      expect(getEnrichment(ctx).appliedFilters).toBe('event=Tornado Warning');
    });

    it('runs a national search when every filter is genuinely omitted', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({});
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts).toHaveLength(0);
      expect(getEnrichment(ctx).appliedFilters).toBe('national (no filters)');
      expect(mockSearchAlerts).toHaveBeenCalledOnce();
    });

    it('salvages a whitespace-padded point instead of rejecting it as blank', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '  47.6,-122.3  ' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ point: '47.6,-122.3' }),
        ctx,
      );
    });

    it('salvages a whitespace-padded area instead of rejecting it as blank', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ area: ' wa ' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(expect.objectContaining({ area: 'WA' }), ctx);
    });

    it('reports a blank point as a blank filter, not a malformed point', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '   ' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'blank_location_filter' },
      });
    });

    it('still reports a malformed non-blank point as invalid_point', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '47.6,' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_point' },
      });
    });

    it('reports a blank zone as a blank filter, not an invalid zone shape', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: '' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'blank_location_filter' },
      });
    });

    it('reports a blank area as a blank filter, not an invalid area code', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ area: '' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'blank_location_filter' },
      });
    });
  });

  describe('region filters (issue #32)', () => {
    it('passes region_type through to the service', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ region_type: 'Marine' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ region_type: 'Marine' }),
        ctx,
      );
      expect(getEnrichment(ctx).appliedFilters).toContain('region_type=Marine');
    });

    it('passes a multi-value region array through to the service', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ region: ['GL', 'GM'] });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ region: ['GL', 'GM'] }),
        ctx,
      );
      expect(getEnrichment(ctx).appliedFilters).toContain('region=GL, GM');
    });

    it.each([
      ['region_type + area', { region_type: 'Marine', area: 'WA' }],
      ['region_type + point', { region_type: 'Land', point: '47.6,-122.3' }],
      ['region_type + zone', { region_type: 'Land', zone: 'WAZ558' }],
      ['region + area', { region: ['GL'], area: 'WA' }],
      ['region + point', { region: ['GL'], point: '47.6,-122.3' }],
      ['region + zone', { region: ['GL'], zone: 'WAZ558' }],
      ['region_type + region', { region_type: 'Marine', region: ['GL'] }],
    ] as const)('rejects %s as mutually exclusive', async (_label, args) => {
      // Upstream answers each of these pairings with a 400 naming the conflict —
      // including region_type with region, which are incompatible with each other.
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse(args);
      const result = searchAlertsTool.handler(input, ctx);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'mutually_exclusive_filters' },
      });
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('rejects an explicitly empty region array before the upstream call', async () => {
      // `?region=` returns NWS's raw enumeration error; the empty array must be
      // caught locally under the declared reason instead.
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ region: [] });
      const result = searchAlertsTool.handler(input, ctx);

      await expect(result).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'empty_filter_array',
          recovery: { hint: expect.stringContaining('Omit') },
        },
      });
      await expect(result).rejects.toThrow('region');
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('reports an empty region as its own problem rather than as a mutex conflict', async () => {
      // Ordering pinned by issue #30: the empty-array check runs ahead of the
      // mutual-exclusion check, so the caller learns which filter is unusable.
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ region: [], area: 'WA' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'empty_filter_array' },
      });
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('rejects an unknown region_type at the schema, keeping semantic reasons for the handler', () => {
      // A closed set is a type constraint: bad literals fail as -32602 at the
      // transport, the same way a bad severity literal already does.
      expect(() => searchAlertsTool.input.parse({ region_type: 'land' })).toThrow();
      expect(() => searchAlertsTool.input.parse({ region_type: '' })).toThrow();
      expect(() => searchAlertsTool.input.parse({ region: ['ZZ'] })).toThrow();
    });

    it('advertises region without a minimum item count so the handler owns the empty case', () => {
      // A schema-level .min(1) would reject `region: []` at the transport as a
      // generic -32602, making the declared reason and hint unreachable.
      const schema = z.toJSONSchema(searchAlertsTool.input, { io: 'input' }) as {
        properties: Record<string, Record<string, unknown>>;
      };

      expect(schema.properties.region).toMatchObject({ type: 'array' });
      expect(schema.properties.region).not.toHaveProperty('minItems');
      expect(schema.properties.region_type).toMatchObject({ enum: ['Land', 'Marine'] });
    });

    it('leaves a national search unfiltered when neither region filter is supplied', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({});
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.not.objectContaining({ region_type: expect.anything() }),
        ctx,
      );
      expect(getEnrichment(ctx).appliedFilters).toBe('national (no filters)');
    });
  });

  describe('marine area codes', () => {
    it('accepts valid marine area code PZ', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ area: 'PZ' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(expect.objectContaining({ area: 'PZ' }), ctx);
    });

    it('accepts valid marine area code GM', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
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

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ event: ['tornado'] });
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0]!.event).toBe('Tornado Warning');
    });

    it('includes event in enrichment filter summary', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ event: ['tornado'] });
      await searchAlertsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.appliedFilters).toContain('event=tornado');
    });
  });

  describe('alert cap at 25', () => {
    it('caps output at 25 alerts when upstream returns more, and offers the rest via nextCursor', async () => {
      const manyAlerts = Array.from({ length: 30 }, (_, i) =>
        makeAlert({ id: `urn:test:${i}`, event: 'Wind Advisory' }),
      );
      mockSearchAlerts.mockResolvedValueOnce({ alerts: manyAlerts });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({});
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts).toHaveLength(25);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(30);
      expect(enrichment.shownCount).toBe(25);
      // The 5 matches past the cap are reachable, not merely disclosed.
      expect(enrichment.nextCursor).toEqual(expect.any(String));
      expect(enrichment.notice).toContain('25 of 30');
    });

    it('returns all alerts when count is under the cap', async () => {
      const alerts = [makeAlert(), makeAlert({ id: 'urn:test:2', event: 'Flood Watch' })];
      mockSearchAlerts.mockResolvedValueOnce({ alerts });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
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

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
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

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ limit: 10 });
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts).toHaveLength(2);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.totalCount).toBe(2);
      expect(enrichment.shownCount).toBe(2);
    });

    it('keeps limit out of the applied-filters echo (it shapes the response, not the query)', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
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

  describe('cursor pagination (issue #29)', () => {
    /** Build a match set of `count` distinguishable alerts. */
    function alertList(count: number): AlertSearchResult {
      return {
        alerts: Array.from({ length: count }, (_, index) =>
          makeAlert({ id: `urn:test:${String(index).padStart(3, '0')}`, event: 'Wind Advisory' }),
        ),
      };
    }

    /** Run one page against the currently mocked match set. */
    async function page(limit: number, cursor?: string) {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const result = await searchAlertsTool.handler(input, ctx);
      return { result, enrichment: getEnrichment(ctx) };
    }

    it('offers a nextCursor and a truncation notice when matches remain beyond the limit', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const { result, enrichment } = await page(25);

      expect(result.alerts).toHaveLength(25);
      expect(enrichment.nextCursor).toEqual(expect.any(String));
      expect(enrichment.notice).toContain('cursor');
    });

    it('walks consecutive pages over one fetched match set with no overlap and no gaps', async () => {
      // The mock returns the same array on every call, so this proves contiguity
      // within a single fetch. The active-alert feed changes continuously, so the
      // same guarantee deliberately is NOT claimed across separate live calls.
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const seen: string[] = [];
      const pageSizes: number[] = [];
      let cursor: string | undefined;
      do {
        const { result, enrichment } = await page(25, cursor);
        seen.push(...result.alerts.map((a) => a.id));
        pageSizes.push(result.alerts.length);
        cursor = enrichment.nextCursor as string | undefined;
      } while (cursor);

      expect(pageSizes).toEqual([25, 25, 23]);
      expect(seen).toEqual(
        Array.from({ length: 73 }, (_, index) => `urn:test:${String(index).padStart(3, '0')}`),
      );
      expect(new Set(seen).size).toBe(73);
    });

    it('keeps shownCount the size of this page, smaller than limit on a final partial page (contract: issue #21)', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const { result, enrichment } = await page(25, encodeCursor({ offset: 50, limit: 25 }));

      expect(result.alerts).toHaveLength(23);
      expect(enrichment.shownCount).toBe(23);
      expect(enrichment.shownCount).not.toBe(25);
    });

    it('keeps totalCount the full match count on every page', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const first = await page(25);
      const second = await page(25, first.enrichment.nextCursor as string);

      expect(first.enrichment.totalCount).toBe(73);
      expect(second.enrichment.totalCount).toBe(73);
    });

    it('omits nextCursor entirely when every match fits one page', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(3));

      const { result, enrichment } = await page(25);

      expect(result.alerts).toHaveLength(3);
      expect(enrichment).not.toHaveProperty('nextCursor');
      expect(enrichment.notice).toBeUndefined();
    });

    it('omits nextCursor when the final page ends exactly on the match count', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(50));

      const first = await page(25);
      expect(first.enrichment.nextCursor).toEqual(expect.any(String));

      const second = await page(25, first.enrichment.nextCursor as string);
      expect(second.result.alerts).toHaveLength(25);
      expect(second.result.alerts[24]!.id).toBe('urn:test:049');
      expect(second.enrichment).not.toHaveProperty('nextCursor');
    });

    it('returns an empty page for a cursor whose offset equals the match count', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(50));

      const { result, enrichment } = await page(25, encodeCursor({ offset: 50, limit: 25 }));

      expect(result.alerts).toHaveLength(0);
      expect(enrichment.totalCount).toBe(50);
      expect(enrichment.shownCount).toBe(0);
      expect(enrichment).not.toHaveProperty('nextCursor');
      expect(enrichment.notice).toContain('past the end');
    });

    it('returns an empty page for a cursor past the end of the match set', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(50));

      const { result, enrichment } = await page(25, encodeCursor({ offset: 500, limit: 25 }));

      expect(result.alerts).toHaveLength(0);
      expect(enrichment).not.toHaveProperty('nextCursor');
      expect(enrichment.notice).toContain('past the end');
    });

    it('clamps an oversized cursor page size to the 25-alert cap', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const { result, enrichment } = await page(25, encodeCursor({ offset: 0, limit: 1000 }));

      expect(result.alerts).toHaveLength(25);
      expect(enrichment.shownCount).toBe(25);
      expect(enrichment.totalCount).toBe(73);
    });

    it('rejects a malformed cursor with InvalidParams (-32602), per the MCP pagination spec', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(50));

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ cursor: 'not-a-real-cursor' });

      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
      });
    });

    it('treats an empty-string cursor as the first page rather than a blank filter', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const { result, enrichment } = await page(25, '');

      expect(result.alerts[0]!.id).toBe('urn:test:000');
      expect(enrichment.shownCount).toBe(25);
    });

    it('keeps cursor out of the applied-filters echo (it shapes the response, not the query)', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const first = await page(25);
      const second = await page(25, first.enrichment.nextCursor as string);

      expect(second.enrichment.appliedFilters).toBe('national (no filters)');
    });

    it('scopes the continuation guarantee to one fetch, never across separate live calls', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const { enrichment } = await page(25);
      const notice = enrichment.notice as string;

      // The active-alert set churns continuously; the notice must not promise a
      // gap-free/overlap-free walk across separate calls.
      expect(notice).toMatch(/re-?fetch|changes between calls|as it stands/i);
      expect(notice).not.toMatch(/guarantee[sd]? (?:no|gap-free)/i);
    });

    it('renders the cursor-selected window in format(), not the first window', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const first = await page(25);
      const second = await page(25, first.enrichment.nextCursor as string);

      const blocks = searchAlertsTool.format!(second.result);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('urn:test:025');
      expect(text).toContain('urn:test:049');
      expect(text).not.toContain('urn:test:024');
      expect(text).not.toContain('urn:test:050');
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

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({});
      const result = await searchAlertsTool.handler(input, ctx);

      expect(result.alerts[0]!.headline).toBeNull();
      expect(result.alerts[0]!.instruction).toBeNull();
      expect(result.alerts[0]!.onset).toBeNull();
      expect(result.alerts[0]!.ends).toBeNull();
      expect(result.alerts[0]!.expires).toBeNull();
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

    it('accepts an alert whose upstream description is null (issue #37)', async () => {
      const alert = makeAlert({ description: null });
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [alert] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({});
      const result = await searchAlertsTool.handler(input, ctx);

      /**
       * The regression lives at the output-schema boundary, not in the handler:
       * `description` was declared non-nullable while NWS returns null for it on
       * some alerts, so a single such alert rejected the whole response instead of
       * coming back with a null field. Parsing the result is the assertion.
       */
      const parsed = searchAlertsTool.output.parse(result);
      expect(parsed.alerts).toHaveLength(1);
      expect(parsed.alerts[0]!.description).toBeNull();
    });

    it('format() omits the description paragraph when it is null', () => {
      const withText = searchAlertsTool.format!({
        alerts: [makeAlert({ description: 'Take shelter.' })],
      });
      const withNull = searchAlertsTool.format!({
        alerts: [makeAlert({ description: null })],
      });

      const kept = (withText[0] as { type: 'text'; text: string }).text;
      const omitted = (withNull[0] as { type: 'text'; text: string }).text;

      expect(kept).toContain('Take shelter.');
      expect(omitted).not.toContain('Take shelter.');
      expect(omitted).not.toContain('null');
      expect(omitted).toContain('**From:** NWS Norman OK');
      /**
       * Omitted, not blanked. Pushing a null description leaves the surrounding
       * spacer lines behind, so the paragraph becomes a run of empty lines rather
       * than disappearing — which `not.toContain` cannot see.
       */
      expect(omitted).not.toMatch(/\n{3,}/);
      expect(kept).not.toMatch(/\n{3,}/);
    });
  });

  describe('severity/urgency/certainty filters in enrichment', () => {
    it('includes severity in enrichment filter summary', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ severity: ['Extreme', 'Severe'] });
      await searchAlertsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.appliedFilters).toContain('severity=Extreme, Severe');
    });

    it('includes urgency in enrichment filter summary', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ urgency: ['Immediate'] });
      await searchAlertsTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.appliedFilters).toContain('urgency=Immediate');
    });
  });
});
