/**
 * @fileoverview Extended tests for nws_search_alerts: point validation edge cases,
 * zone filter, marine area codes, event filtering, caps, cursors, and windowed
 * searches.
 * @module tests/tools/search-alerts-extended
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertSearchResult, NwsService } from '@/services/nws/nws-service.js';
import { windowAlertMessages } from '../fixtures/nws-responses.js';

/** The filters the tool hands the service, as the service declares them. */
type SearchParams = Parameters<NwsService['searchAlerts']>[0];
/** A windowed search as the tool hands it to the service. */
type WindowParams = Parameters<NwsService['searchAlertWindow']>[0];

const mockSearchAlerts =
  vi.fn<(params: SearchParams, ctx: unknown) => Promise<AlertSearchResult>>();
const mockSearchAlertWindow =
  vi.fn<(params: WindowParams, ctx: unknown) => Promise<AlertSearchResult>>();
const mockMatchAlertEventTypes =
  vi.fn<(terms: readonly string[], ctx: unknown) => Promise<readonly string[]>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({
    searchAlerts: mockSearchAlerts,
    searchAlertWindow: mockSearchAlertWindow,
    matchAlertEventTypes: mockMatchAlertEventTypes,
  }),
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
    office: null,
    vtec: [],
    nwsHeadline: null,
    hazard: null,
    ...overrides,
  };
}

describe('nws_search_alerts extended', () => {
  beforeEach(() => {
    mockSearchAlerts.mockReset();
    mockSearchAlertWindow.mockReset();
    mockMatchAlertEventTypes.mockReset();
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

    it('answers the service’s out-of-coverage invalid_point with a recovery naming US coverage on both surfaces (issue #58)', async () => {
      // The service raises the reason alone, as it does for NWS's out-of-bounds 400;
      // the tool's declaration supplies the recovery.
      const message =
        'Point "10,10" is outside NWS coverage (NWS: Parameter "point" is invalid: out of bounds).';
      mockSearchAlerts.mockRejectedValueOnce(
        validationError(message, { status: 400, reason: 'invalid_point' }),
      );
      const hint =
        'Provide "lat,lon" with latitude -90 to 90 and longitude -180 to 180 (e.g., "47.6,-122.3") for a location NWS covers: the US states, territories, or adjacent marine areas.';

      const result = await runToolContract(searchAlertsTool, { point: '10,10' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message,
          data: { status: 400, reason: 'invalid_point', recovery: { hint } },
        },
      });
      const text = result.content.map((block) => (block as { text: string }).text).join('\n');
      expect(text).toContain(message);
      expect(text).toContain(`Recovery: ${hint}`);
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
      const result = await runToolContract(searchAlertsTool, { zone: 'not-a-zone' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: expect.stringContaining('Invalid zone'),
          data: {
            reason: 'invalid_zone',
            recovery: { hint: expect.stringContaining('WAZ558') },
          },
        },
      });
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

  describe('blank optional filters (issues #30, #46)', () => {
    /** Text of every content block — what a format()-only client reads. */
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((block) => ('text' in block ? block.text : '')).join('\n');

    it.each([
      ['area', { area: '   ' }],
      ['point', { point: '' }],
      ['zone', { zone: '   ' }],
    ] as const)('treats a blank %s as unset, running the national search', async (field, args) => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const result = await runToolContract(searchAlertsTool, args);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ appliedFilters: 'national (no filters)' });
      expect(textOf(result)).toContain('**Filters:** `national (no filters)`');
      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ [field]: undefined }),
        expect.anything(),
      );
    });

    it.each(['event', 'severity', 'urgency', 'certainty', 'region'] as const)(
      'treats an explicitly empty %s array as unset',
      async (field) => {
        mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

        const result = await runToolContract(searchAlertsTool, { [field]: [] });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({ appliedFilters: 'national (no filters)' });
        expect(textOf(result)).toContain('**Filters:** `national (no filters)`');
        expect(mockSearchAlerts).toHaveBeenCalledWith(
          expect.objectContaining({ [field]: undefined }),
          expect.anything(),
        );
      },
    );

    it('treats an event array whose entries are all blank as unset', async () => {
      // A blank term filters nothing, so the array carries no filter at all and
      // the echo never shows `event=` for a term that was not applied.
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ event: ['   ', ''] });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ event: undefined }),
        ctx,
      );
      expect(getEnrichment(ctx).appliedFilters).toBe('national (no filters)');
    });

    it('drops every blank at once, keeping the real filters beside them', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({
        area: 'wa',
        point: ' ',
        zone: '',
        region_type: '',
        region: [],
        event: [''],
        severity: ['Severe'],
        urgency: [],
        certainty: [],
        status: '',
      });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        {
          area: 'WA',
          point: undefined,
          zone: undefined,
          region_type: undefined,
          region: undefined,
          event: undefined,
          severity: ['Severe'],
          urgency: undefined,
          certainty: undefined,
          status: 'Actual',
        },
        ctx,
      );
      expect(getEnrichment(ctx).appliedFilters).toBe('area=WA, severity=Severe');
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

    it('treats a whitespace-only point as unset, not as a malformed point', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '   ' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ point: undefined }),
        ctx,
      );
    });

    it('still reports a malformed non-blank point as invalid_point', async () => {
      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ point: '47.6,' });
      await expect(searchAlertsTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_point' },
      });
    });

    it('treats a blank zone as unset, not as an invalid zone shape', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ zone: '' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ zone: undefined }),
        ctx,
      );
    });

    it('treats a blank area as unset, not as an invalid area code', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ area: '' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ area: undefined }),
        ctx,
      );
    });

    it('still rejects a real non-blank value that fails its check', async () => {
      const cases = [
        [{ area: 'ZZ' }, 'invalid_area_code'],
        [{ point: '47.6,' }, 'invalid_point'],
        [{ zone: 'WAX123' }, 'invalid_zone'],
        [{ area: 'WA', zone: 'WAZ558', point: '' }, 'mutually_exclusive_filters'],
      ] as const;
      for (const [args, reason] of cases) {
        const result = await runToolContract(searchAlertsTool, args);
        expect(result.structuredContent, reason).toMatchObject({ error: { data: { reason } } });
      }
      expect(mockSearchAlerts).not.toHaveBeenCalled();
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

    it('keeps an explicitly empty region array off the service call', async () => {
      // `?region=` returns NWS's raw enumeration error, so the empty array is
      // reduced to unset rather than forwarded.
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ region: [] });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ region: undefined }),
        ctx,
      );
      expect(getEnrichment(ctx).appliedFilters).toBe('national (no filters)');
    });

    it('lets an empty region sit beside area without a mutex conflict', async () => {
      // The empty region is unset, so area is the only location filter applied.
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
      const input = searchAlertsTool.input.parse({ region: [], area: 'WA' });
      await searchAlertsTool.handler(input, ctx);

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ area: 'WA', region: undefined }),
        ctx,
      );
      expect(getEnrichment(ctx).appliedFilters).toBe('area=WA');
    });

    it('rejects an unknown region_type at the schema, keeping semantic reasons for the handler', () => {
      // A closed set is a type constraint: bad literals fail as -32602 at the
      // transport, the same way a bad severity literal already does.
      expect(() => searchAlertsTool.input.parse({ region_type: 'land' })).toThrow();
      expect(() => searchAlertsTool.input.parse({ region: ['ZZ'] })).toThrow();
      expect(() => searchAlertsTool.input.parse({ status: 'actual' })).toThrow();
    });

    it('maps a blank region_type to unset and a blank status to its default at the schema', () => {
      const input = searchAlertsTool.input.parse({ region_type: '', status: '' });

      expect(input.region_type).toBeUndefined();
      expect(input.status).toBe('Actual');
    });

    it('advertises region without a minimum item count so an empty array stays unset', () => {
      // A schema-level .min(1) would reject `region: []` at the transport as a
      // generic -32602 instead of treating it as omitted.
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
      expect(enrichment.shown).toBe(25);
      // The 5 matches past the cap are reachable, not merely disclosed.
      expect(enrichment.nextCursor).toEqual(expect.any(String));
      expect(enrichment.notice).toContain('25 of 30');
    });

    it('declares totalCount as a count of distinct alerts (issue #36)', () => {
      // Deduplication changes what "matches" means. The field a caller reads to
      // detect truncation has to say which quantity it now reports.
      expect(searchAlertsTool.enrichment?.totalCount.description).toMatch(/distinct/i);
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
      expect(enrichment.shown).toBe(2);
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
      expect(enrichment.shown).toBe(3); // the slice
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
      expect(enrichment.shown).toBe(2);
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

    it('accepts any safe-integer limit past the 25-alert cap, and rejects beyond the safe range', () => {
      expect(searchAlertsTool.input.parse({ limit: 26 }).limit).toBe(26);
      expect(searchAlertsTool.input.parse({ limit: 10_001 }).limit).toBe(10_001);
      expect(searchAlertsTool.input.parse({ limit: Number.MAX_SAFE_INTEGER }).limit).toBe(
        Number.MAX_SAFE_INTEGER,
      );
      expect(() => searchAlertsTool.input.parse({ limit: 2 ** 53 })).toThrow();
    });
  });

  describe('limit past the 25-alert cap (issue #53)', () => {
    type Surfaces = { data: Record<string, unknown> & { alerts: { id: string }[] }; text: string };

    /** One call through the production parse, returning both client surfaces. */
    async function call(args: Record<string, unknown>): Promise<Surfaces> {
      const result = await runToolContract(searchAlertsTool, args);
      expect(result.isError).toBeFalsy();
      return {
        data: result.structuredContent as Surfaces['data'],
        text: result.content.map((block) => (block as { text: string }).text).join('\n'),
      };
    }

    function alertList(count: number): AlertSearchResult {
      return {
        alerts: Array.from({ length: count }, (_, index) =>
          makeAlert({ id: `urn:test:${String(index).padStart(3, '0')}`, event: 'Wind Advisory' }),
        ),
      };
    }

    const CLAMP = 'Requested limit 26 exceeds the per-page cap of 25; this page holds up to 25.';
    /** The continuation guidance a page of 25 of 30 alerts carries. */
    const PAGE_25_OF_30 =
      'Returning 25 of 30 matching alerts. Pass nextCursor back as cursor for the next page. Alerts are contiguous within this response only — every call re-fetches the active-alert feed, so a continued page covers the collection as it stands at that moment, and alerts issued or expired in between can shift entries across the page boundary. Duplicate alerts are collapsed on id within each fetch, so the same id arriving on two pages means the active set moved between calls, not that one alert was returned twice.';

    it('serves 25 of 30, discloses the clamp on both surfaces, and continues to the other 5', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(30));

      const first = await call({ limit: 26 });

      expect(first.data.alerts).toHaveLength(25);
      expect(first.data).toMatchObject({
        totalCount: 30,
        shown: 25,
        requestedLimit: 26,
        effectiveLimit: 25,
      });
      expect(first.data.nextCursor).toEqual(expect.any(String));
      // One notice: the clamp first, then the page's own continuation guidance.
      expect(first.data.notice).toBe(`${CLAMP} ${PAGE_25_OF_30}`);
      expect(first.text).toContain(`${CLAMP} ${PAGE_25_OF_30}`);
      expect(first.text).toContain('**Requested Limit:** 26');
      expect(first.text).toContain('**Applied Limit:** 25');

      const second = await call({ cursor: first.data.nextCursor });

      expect(second.data.alerts.map((a) => a.id)).toEqual(
        Array.from({ length: 5 }, (_, index) => `urn:test:0${25 + index}`),
      );
      expect(second.data).not.toHaveProperty('nextCursor');
      expect(second.data).not.toHaveProperty('notice');
      expect(second.data).not.toHaveProperty('requestedLimit');
      expect(second.data).not.toHaveProperty('effectiveLimit');
    });

    it('composes the clamp with the no-match notice', async () => {
      mockSearchAlerts.mockResolvedValue({ alerts: [] });

      const { data } = await call({ limit: 26, area: 'WA' });

      expect(data.notice).toBe(
        `${CLAMP} No active alerts matched: area=WA. Try a broader area, remove severity or event filters, or use nws_list_alert_types to verify event names.`,
      );
    });

    it('returns a limit within the cap exactly as before, with no clamp disclosure', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(30));

      const { data, text } = await call({ limit: 25 });

      expect(data.alerts).toHaveLength(25);
      expect(data).not.toHaveProperty('requestedLimit');
      expect(data).not.toHaveProperty('effectiveLimit');
      // The continuation guidance alone, with no clamp sentence ahead of it.
      expect(data.notice).toBe(PAGE_25_OF_30);
      expect(text).not.toContain('**Requested Limit:**');
      expect(text).not.toContain('**Applied Limit:**');
    });

    it('continues a cursor at its own page size when a different limit is sent with it, disclosing nothing', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(30));

      const first = await call({ limit: 10 });
      const second = await call({ cursor: first.data.nextCursor, limit: 500 });

      expect(second.data.alerts).toHaveLength(10);
      expect(second.data.alerts[0]!.id).toBe('urn:test:010');
      expect(second.data).not.toHaveProperty('requestedLimit');
      expect(second.data).not.toHaveProperty('effectiveLimit');
    });

    it.each([
      ['past the safe-integer range', 2 ** 53],
      ['zero', 0],
      ['fractional', 2.5],
    ])('rejects a limit %s as invalid_arguments', async (_label, limit) => {
      const result = await runToolContract(searchAlertsTool, { limit });
      const { error } = result.structuredContent as {
        error: { code: number; data?: { reason?: string } };
      };

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(mockSearchAlerts).not.toHaveBeenCalled();
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

    it('keeps shown the size of this page, smaller than limit on a final partial page (contract: issue #21)', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const { result, enrichment } = await page(25, encodeCursor({ offset: 50, limit: 25 }));

      expect(result.alerts).toHaveLength(23);
      // The honesty #21 protects: this count tracks what came back, never the
      // requested limit and never the full match count.
      expect(enrichment.shown).toBe(result.alerts.length);
      expect(enrichment.shown).not.toBe(25);
      expect(enrichment.shown).not.toBe(enrichment.totalCount);
      expect(enrichment.totalCount).toBe(73);
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
      expect(enrichment.shown).toBe(0);
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
      expect(enrichment.shown).toBe(25);
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
      expect(enrichment.shown).toBe(25);
    });

    it('keeps cursor out of the applied-filters echo (it carries the query, and the echo names that query)', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const first = await page(25);
      const second = await page(25, first.enrichment.nextCursor as string);

      // The continued page echoes the national query the token carries, never the token itself.
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

    it('separates cross-call drift from in-fetch duplication in the paging notice (issue #36)', async () => {
      mockSearchAlerts.mockResolvedValue(alertList(73));

      const { enrichment } = await page(25);
      const notice = enrichment.notice as string;

      // The drift language alone reads as though it covers repeated entries. A
      // caller walking pages has to be able to tell "the page boundary moved"
      // from "the same alert came back twice" — the latter is collapsed now, and
      // the notice is where that distinction reaches the caller.
      expect(notice).toMatch(/duplicate/i);
      expect(notice).toMatch(/\bid\b/);
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

  describe('query-carrying cursor (issue #63)', () => {
    type Surfaces = {
      data: Record<string, unknown> & { alerts: { id: string }[] };
      text: string;
    };

    /** `count` distinguishable alerts whose ids carry `prefix`. */
    function alertSet(prefix: string, count: number): AlertSearchResult {
      return {
        alerts: Array.from({ length: count }, (_, index) =>
          makeAlert({ id: `urn:${prefix}:${String(index).padStart(3, '0')}` }),
        ),
      };
    }

    const PA = alertSet('pa', 29);
    const AK = alertSet('ak', 31);
    const NATIONAL = alertSet('us', 47);

    /** Answer each query with its own match set, as /alerts/active does. */
    function serveByQuery() {
      mockSearchAlerts.mockImplementation(async (params) => {
        if (params.region?.includes('PA')) return PA;
        if (params.area === 'AK') return AK;
        return NATIONAL;
      });
    }

    /** One call through the production parse, returning both client surfaces. */
    async function call(args: Record<string, unknown>): Promise<Surfaces> {
      const result = await runToolContract(searchAlertsTool, args);
      expect(result.isError).toBeFalsy();
      return {
        data: result.structuredContent as Surfaces['data'],
        text: result.content.map((block) => (block as { text: string }).text).join('\n'),
      };
    }

    const ids = (surfaces: Surfaces) => surfaces.data.alerts.map((alert) => alert.id);
    const lastParams = () => mockSearchAlerts.mock.calls.at(-1)?.[0];

    it('mints a token carrying the normalized filters with the next offset and applied page size', async () => {
      serveByQuery();

      const first = await call({ region: ['PA'], event: [' wind ', ''], limit: 3 });

      expect(first.data).toMatchObject({
        totalCount: 29,
        shown: 3,
        appliedFilters: 'region=PA, event=wind',
      });
      const token = decodeCursor(first.data.nextCursor as string, createMockContext());
      expect(token).toEqual({
        offset: 3,
        limit: 3,
        filters: { region: ['PA'], event: ['wind'], status: 'Actual' },
      });
    });

    it('continues the minting query when the cursor is sent alone', async () => {
      serveByQuery();

      const first = await call({ region: ['PA'], limit: 3 });
      const second = await call({ cursor: first.data.nextCursor });

      expect(ids(second)).toEqual(['urn:pa:003', 'urn:pa:004', 'urn:pa:005']);
      expect(second.data).toMatchObject({
        totalCount: first.data.totalCount,
        appliedFilters: first.data.appliedFilters,
        shown: 3,
      });
      expect(second.data.appliedFilters).toBe('region=PA');
      expect(lastParams()).toMatchObject({ region: ['PA'], status: 'Actual' });
      expect(second.text).toContain('**Filters:** `region=PA`');
    });

    it('ignores filter inputs sent with a query-carrying cursor', async () => {
      serveByQuery();

      const first = await call({ region: ['PA'], limit: 3 });
      const second = await call({ area: 'AK', severity: ['Minor'], cursor: first.data.nextCursor });

      expect(ids(second)).toEqual(['urn:pa:003', 'urn:pa:004', 'urn:pa:005']);
      expect(second.data.appliedFilters).toBe('region=PA');
      expect(second.data.totalCount).toBe(29);
      const params = lastParams();
      expect(params).toMatchObject({ region: ['PA'] });
      expect(params?.area).toBeUndefined();
      expect(params?.severity).toBeUndefined();
    });

    it('returns the same page as before when the same filters are resent with the cursor (regression)', async () => {
      serveByQuery();

      const first = await call({ region: ['PA'], limit: 3 });
      const alone = await call({ cursor: first.data.nextCursor });
      const resent = await call({ region: ['PA'], cursor: first.data.nextCursor });

      expect(ids(resent)).toEqual(['urn:pa:003', 'urn:pa:004', 'urn:pa:005']);
      expect(resent.data).toEqual(alone.data);
    });

    it('walks every page of a filtered query with the cursor alone, with no overlap and no gaps', async () => {
      serveByQuery();

      const seen: string[] = [];
      const sizes: number[] = [];
      let surfaces = await call({ region: ['PA'], limit: 10 });
      for (;;) {
        seen.push(...ids(surfaces));
        sizes.push(surfaces.data.alerts.length);
        expect(surfaces.data.appliedFilters).toBe('region=PA');
        const next = surfaces.data.nextCursor as string | undefined;
        if (!next) break;
        surfaces = await call({ cursor: next });
      }

      expect(sizes).toEqual([10, 10, 9]);
      expect(seen).toEqual(PA.alerts.map((alert) => alert.id));
    });

    it('resumes a 0.11.0 {offset, limit} token against the filters sent with it (regression)', async () => {
      serveByQuery();
      const legacy = encodeCursor({ offset: 3, limit: 3 });

      const withFilters = await call({ region: ['PA'], cursor: legacy });
      const otherQuery = await call({ area: 'AK', cursor: legacy });
      const alone = await call({ cursor: legacy });

      expect(ids(withFilters)).toEqual(['urn:pa:003', 'urn:pa:004', 'urn:pa:005']);
      expect(withFilters.data.appliedFilters).toBe('region=PA');
      expect(ids(otherQuery)).toEqual(['urn:ak:003', 'urn:ak:004', 'urn:ak:005']);
      expect(otherQuery.data.appliedFilters).toBe('area=AK');
      expect(ids(alone)).toEqual(['urn:us:003', 'urn:us:004', 'urn:us:005']);
      expect(alone.data.appliedFilters).toBe('national (no filters)');
      // A legacy token's next page is minted in the new shape, carrying the sent filters.
      expect(decodeCursor(withFilters.data.nextCursor as string, createMockContext())).toEqual({
        offset: 6,
        limit: 3,
        filters: { region: ['PA'], status: 'Actual' },
      });
    });

    it('serves a carried page size above the cap as 25 (regression)', async () => {
      serveByQuery();

      const surfaces = await call({
        cursor: encodeCursor({
          offset: 0,
          limit: 1000,
          filters: { region: ['PA'], status: 'Actual' },
        }),
      });

      expect(surfaces.data.alerts).toHaveLength(25);
      expect(surfaces.data.appliedFilters).toBe('region=PA');
      expect(surfaces.data).not.toHaveProperty('requestedLimit');
      expect(decodeCursor(surfaces.data.nextCursor as string, createMockContext())).toMatchObject({
        offset: 25,
        limit: 25,
      });
    });

    it('names the cursor’s filters in the past-end notice, with a restart that resends them', async () => {
      serveByQuery();

      const surfaces = await call({
        area: 'AK',
        cursor: encodeCursor({
          offset: 500,
          limit: 3,
          filters: { region: ['PA'], status: 'Actual' },
        }),
      });

      expect(surfaces.data.alerts).toHaveLength(0);
      expect(surfaces.data).not.toHaveProperty('nextCursor');
      const notice =
        'The cursor points past the end of the 29 alerts matching: region=PA. To restart from the first match, call again with those filters, limit 3, and no cursor.';
      expect(surfaces.data.notice).toBe(notice);
      expect(surfaces.text).toContain(notice);
    });

    it('keeps the national past-end restart to a call without a cursor', async () => {
      serveByQuery();

      const surfaces = await call({ cursor: encodeCursor({ offset: 500, limit: 3 }) });

      expect(surfaces.data.notice).toBe(
        'The cursor points past the end of the 47 alerts matching: national (no filters). Call again with limit 3 and no cursor to restart from the first match.',
      );
    });

    it('normalizes carried filters the way it normalizes the inputs', async () => {
      serveByQuery();

      const surfaces = await call({
        cursor: encodeCursor({
          offset: 0,
          limit: 3,
          filters: { area: ' ak ', point: '', event: ['', ' wind '] },
        }),
      });

      expect(ids(surfaces)).toEqual(['urn:ak:000', 'urn:ak:001', 'urn:ak:002']);
      expect(surfaces.data.appliedFilters).toBe('area=AK, event=wind');
      expect(lastParams()).toMatchObject({ area: 'AK', event: ['wind'], status: 'Actual' });
      expect(lastParams()?.point).toBeUndefined();
    });

    it.each([
      ['an empty string', ''],
      ['whitespace only', '   '],
    ])('treats a cursor that is %s as the first page', async (_label, cursor) => {
      serveByQuery();

      const surfaces = await call({ region: ['PA'], limit: 3, cursor });

      expect(ids(surfaces)).toEqual(['urn:pa:000', 'urn:pa:001', 'urn:pa:002']);
      expect(surfaces.data.appliedFilters).toBe('region=PA');
    });

    const filters = (carried: Record<string, unknown>) =>
      encodeCursor({ offset: 3, limit: 3, filters: carried });

    it.each([
      ['a malformed token', 'not-a-real-cursor'],
      ['a fractional offset', encodeCursor({ offset: 1.5, limit: 3 })],
      ['a fractional limit', encodeCursor({ offset: 3, limit: 0.5 })],
      ['a fractional limit with filters', encodeCursor({ offset: 3, limit: 2.5, filters: {} })],
      [
        'filters that are not an object',
        encodeCursor({ offset: 3, limit: 3, filters: 'region=PA' }),
      ],
      ['filters that are an array', encodeCursor({ offset: 3, limit: 3, filters: ['PA'] })],
      ['two location filters', filters({ area: 'WA', point: '47.6,-122.3' })],
      ['region_type beside region', filters({ region_type: 'Land', region: ['PA'] })],
      ['an unknown area code', filters({ area: 'ZZ' })],
      ['a malformed point', filters({ point: '47.6,' })],
      ['a point out of bounds', filters({ point: '91,0' })],
      ['a zone with an unknown prefix', filters({ zone: 'QQZ123' })],
      ['an unknown severity', filters({ severity: ['Bogus'] })],
      ['an unknown marine region', filters({ region: ['XX'] })],
      ['an unknown status', filters({ status: 'Nope' })],
      ['an event that is not a list', filters({ event: 'tornado' })],
      // The filter inputs reject an unknown key, so a carried one is refused too.
      ['an unknown filter key', filters({ region: ['PA'], constructor: 'x' })],
      [
        'a __proto__ filter key',
        Buffer.from('{"offset":3,"limit":3,"filters":{"__proto__":{"zone":".."}}}').toString(
          'base64url',
        ),
      ],
    ])('rejects %s as invalid_cursor before any NWS request', async (_label, cursor) => {
      serveByQuery();

      const result = await runToolContract(searchAlertsTool, { region: ['PA'], cursor });
      const { error } = result.structuredContent as {
        error: { code: number; data?: { reason?: string } };
      };

      expect(result.isError).toBe(true);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_cursor');
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('says in the cursor description that the token carries the query and page size', () => {
      const { description } = searchAlertsTool.input.shape.cursor;

      expect(description).toMatch(/carries (?:the|that) query's filters, window, and page size/);
      expect(description).toMatch(/first page only/);
    });
  });

  describe('windowed search (issue #81)', () => {
    /** The clock every windowed case runs at. */
    const NOW = '2026-11-11T12:00:00Z';
    /** NOW less the 7 days NWS keeps alert messages for. */
    const CUTOFF = '2026-11-04T12:00:00Z';
    /** The window `windowAlertMessages` was served for. */
    const WINDOW = { start: '2026-11-11T02:00:00Z', end: '2026-11-11T03:00:00Z' } as const;
    const CAP_PREFIX = 'urn:oid:2.49.0.1.840.0.';
    /** The message hashes of the fixture's 4-message tie at 02:44Z, 30-message tie at 02:37Z, and 11-message tie at 02:33Z. */
    const TIE_44 = '0661c42ec6465e3547320c18750c5e69a35c353f';
    const TIE_37 = 'f4bcc0d7975543a3af2853065b60547e3a99236b';
    const TIE_33 = 'c73deb5a8cb86ffaace27e6576331c7beffa3105';
    const RETENTION = `This window starts before ${CUTOFF}, about as far back as NWS keeps alert messages (7 days), so messages issued before then may be missing from it.`;
    const MORE_REMAIN = (shown: number) =>
      `Returning ${shown} alert messages, newest first; older messages in this window remain. Pass nextCursor back as cursor for the next page, which picks up where this one ends; a walk returns each message once.`;

    const fixtureAlerts = windowAlertMessages.map(([id, sent, event, messageType]) =>
      makeAlert({ id, sent, event, messageType }),
    );

    type Surfaces = {
      data: Record<string, unknown> & { alerts: { id: string }[] };
      text: string;
    };
    type Token = {
      offset: number;
      limit: number;
      filters?: Record<string, unknown>;
      keyset?: { sent: string; ids: string[][] };
    };

    /** One call through the production parse, returning both client surfaces. */
    async function call(args: Record<string, unknown>): Promise<Surfaces> {
      const result = await runToolContract(searchAlertsTool, args);
      expect(result.isError).toBeFalsy();
      return {
        data: result.structuredContent as Surfaces['data'],
        text: result.content.map((block) => (block as { text: string }).text).join('\n'),
      };
    }

    /** One call that must fail, returning its error envelope. */
    async function refused(args: Record<string, unknown>) {
      const result = await runToolContract(searchAlertsTool, args);
      expect(result.isError).toBe(true);
      return (
        result.structuredContent as {
          error: { code: number; message: string; data?: { reason?: string } };
        }
      ).error;
    }

    const ids = (surfaces: Surfaces) => surfaces.data.alerts.map((alert) => alert.id);
    const decode = (cursor: unknown) =>
      decodeCursor(cursor as string, createMockContext()) as Token;
    const windowCalls = () => mockSearchAlertWindow.mock.calls.map(([params]) => params);
    /** Requests that reached any service method; a refusal before any request leaves this 0. */
    const serviceCalls = () =>
      mockSearchAlerts.mock.calls.length +
      mockSearchAlertWindow.mock.calls.length +
      mockMatchAlertEventTypes.mock.calls.length;
    /** The message IDs a keyset's groups stand for: one per suffix, or the loose ID itself. */
    const carriedCount = (groups: string[][]) =>
      groups.reduce((count, group) => count + Math.max(group.length - 1, 1), 0);

    /** FNV-1a, for a reproducible reorder. */
    function hash(text: string): number {
      let h = 2166136261;
      for (let index = 0; index < text.length; index++) {
        h = Math.imul(h ^ text.charCodeAt(index), 16777619);
      }
      return h >>> 0;
    }

    /**
     * Answer as `/alerts` does: the messages sent within [start, end] by instant,
     * both ends inclusive, newest first, at most `limit` — and, as NWS does, the
     * messages that share a `sent` instant in a different order on every request.
     */
    function serveWindow(messages: readonly AlertOutput[]) {
      let request = 0;
      mockSearchAlertWindow.mockImplementation(async (params) => {
        request += 1;
        const startMs = params.start === undefined ? -Infinity : Date.parse(params.start);
        const endMs = params.end === undefined ? Infinity : Date.parse(params.end);
        const alerts = messages
          .filter((message) => {
            const sentMs = Date.parse(message.sent);
            return sentMs >= startMs && sentMs <= endMs;
          })
          .sort(
            (a, b) =>
              Date.parse(b.sent) - Date.parse(a.sent) ||
              hash(`${request}:${a.id}`) - hash(`${request}:${b.id}`),
          )
          .slice(0, params.limit);
        return { alerts };
      });
    }

    /** `count` messages an hour apart, the newest at `newest`. */
    function hourly(count: number, newest: string) {
      return Array.from({ length: count }, (_, index) =>
        makeAlert({
          id: `urn:test:hourly:${String(index).padStart(3, '0')}`,
          sent: new Date(Date.parse(newest) - index * 3_600_000).toISOString(),
        }),
      );
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('mints a keyset of the oldest sent instant, in UTC, and the IDs returned there grouped by message hash', async () => {
      const hashA = 'a'.repeat(40);
      const hashB = 'b'.repeat(40);
      const newer = makeAlert({ id: `${CAP_PREFIX}${hashA}.009.1`, sent: '2026-11-11T02:55:00Z' });
      const a1 = makeAlert({ id: `${CAP_PREFIX}${hashA}.001.1`, sent: '2026-11-11T02:50:00Z' });
      // The same instant from offices in other offsets is the same tie.
      const b1 = makeAlert({
        id: `${CAP_PREFIX}${hashB}.002.1`,
        sent: '2026-11-10T18:50:00-08:00',
      });
      const loose = makeAlert({ id: 'urn:test:heartbeat', sent: '2026-11-10T21:50:00-05:00' });
      const a2 = makeAlert({ id: `${CAP_PREFIX}${hashA}.003.2`, sent: '2026-11-11T02:50:00Z' });
      const a3 = makeAlert({ id: `${CAP_PREFIX}${hashA}.004.1`, sent: '2026-11-11T02:50:00Z' });
      const older = makeAlert({ id: 'urn:test:older', sent: '2026-11-11T02:40:00Z' });
      mockSearchAlertWindow.mockResolvedValueOnce({ alerts: [newer, a1, b1, loose, a2, a3] });

      const first = await call({ ...WINDOW, limit: 5 });

      expect(ids(first)).toEqual([newer.id, a1.id, b1.id, loose.id, a2.id]);
      expect(windowCalls()[0]).toMatchObject({ ...WINDOW, status: 'Actual', limit: 6 });
      expect(mockMatchAlertEventTypes).not.toHaveBeenCalled();
      expect(decode(first.data.nextCursor)).toEqual({
        offset: 0,
        limit: 5,
        filters: { ...WINDOW, status: 'Actual' },
        keyset: {
          sent: '2026-11-11T02:50:00Z',
          ids: [[hashA, '001.1', '003.2'], [hashB, '002.1'], ['urn:test:heartbeat']],
        },
      });

      // NWS answers the boundary request with the tie in another order.
      mockSearchAlertWindow.mockResolvedValueOnce({ alerts: [loose, a3, a2, b1, a1, older] });
      const second = await call({ cursor: first.data.nextCursor });

      expect(windowCalls()[1]).toMatchObject({
        start: WINDOW.start,
        end: '2026-11-11T02:50:00Z',
        limit: 4 + 5 + 1,
      });
      expect(ids(second)).toEqual([a3.id, older.id]);
      expect(second.data).not.toHaveProperty('nextCursor');
    });

    it('walks a 30-message tie that spans pages, carrying every ID already returned at it, and returns each of the 51 messages once', async () => {
      serveWindow(fixtureAlerts);

      const seen: string[] = [];
      const sizes: number[] = [];
      const keysets: [string, number, string[]][] = [];
      let surfaces = await call({ ...WINDOW, limit: 7 });
      for (let pages = 1; ; pages++) {
        seen.push(...ids(surfaces));
        sizes.push(surfaces.data.alerts.length);
        const next = surfaces.data.nextCursor;
        if (next === undefined || pages === 20) break;
        const { keyset } = decode(next);
        keysets.push([
          keyset!.sent,
          carriedCount(keyset!.ids),
          keyset!.ids.map((group) => group[0]!),
        ]);
        surfaces = await call({ cursor: next });
      }

      expect(sizes).toEqual([7, 7, 7, 7, 7, 7, 7, 2]);
      expect(seen).toHaveLength(51);
      expect(new Set(seen)).toEqual(new Set(windowAlertMessages.map(([id]) => id)));
      // Inside a tie the carried IDs accumulate; a new boundary instant starts over.
      // Each tie is one product, so its IDs ride as one hash group.
      expect(keysets).toEqual([
        ['2026-11-11T02:44:00Z', 3, [TIE_44]],
        ['2026-11-11T02:37:00Z', 6, [TIE_37]],
        ['2026-11-11T02:37:00Z', 13, [TIE_37]],
        ['2026-11-11T02:37:00Z', 20, [TIE_37]],
        ['2026-11-11T02:37:00Z', 27, [TIE_37]],
        ['2026-11-11T02:33:00Z', 4, [TIE_33]],
        ['2026-11-11T02:33:00Z', 11, [TIE_33]],
      ]);
      // Each request ends at the boundary and asks for the carried IDs, a page, and one more.
      expect(windowCalls().map(({ start, end, limit }) => [start, end, limit])).toEqual([
        [WINDOW.start, WINDOW.end, 8],
        [WINDOW.start, '2026-11-11T02:44:00Z', 3 + 8],
        [WINDOW.start, '2026-11-11T02:37:00Z', 6 + 8],
        [WINDOW.start, '2026-11-11T02:37:00Z', 13 + 8],
        [WINDOW.start, '2026-11-11T02:37:00Z', 20 + 8],
        [WINDOW.start, '2026-11-11T02:37:00Z', 27 + 8],
        [WINDOW.start, '2026-11-11T02:33:00Z', 4 + 8],
        [WINDOW.start, '2026-11-11T02:33:00Z', 11 + 8],
      ]);
      expect(surfaces.data.notice).toBeUndefined();
    });

    it('continues the token’s query when the window inputs are resent with it', async () => {
      serveWindow(fixtureAlerts);

      const first = await call({ ...WINDOW, limit: 7 });
      await call({ cursor: first.data.nextCursor });
      await call({ ...WINDOW, area: 'AK', limit: 3, cursor: first.data.nextCursor });

      const [, alone, resent] = windowCalls();
      expect(resent).toEqual(alone);
      expect(resent).toMatchObject({ end: '2026-11-11T02:44:00Z', limit: 11 });
      expect(resent?.area).toBeUndefined();
    });

    const WINDOW_FILTERS = { ...WINDOW, status: 'Actual' };
    const keyset = (overrides: Record<string, unknown> = {}) => ({
      sent: '2026-11-11T02:37:00Z',
      ids: [[TIE_37, '001.1']],
      ...overrides,
    });
    const windowToken = (body: Record<string, unknown>) =>
      encodeCursor({ offset: 0, limit: 7, ...body });
    const looseIds = (count: number) =>
      Array.from({ length: count }, (_, index): [string] => [`urn:test:seen:${index}`]);

    it.each([
      [
        'a keyset without a window',
        { cursor: windowToken({ filters: { status: 'Actual' }, keyset: keyset() }) },
      ],
      ['a keyset with no filters', { cursor: windowToken({ keyset: keyset() }) }],
      ['window filters without a keyset', { cursor: windowToken({ filters: WINDOW_FILTERS }) }],
      [
        'an {offset, limit} token sent with start',
        { start: WINDOW.start, cursor: encodeCursor({ offset: 3, limit: 3 }) },
      ],
      [
        'an {offset, limit} token sent with end',
        { end: WINDOW.end, cursor: encodeCursor({ offset: 3, limit: 3 }) },
      ],
      [
        'an {offset, limit, filters} token sent with start and end',
        {
          ...WINDOW,
          cursor: encodeCursor({
            offset: 3,
            limit: 3,
            filters: { region: ['PA'], status: 'Actual' },
          }),
        },
      ],
      [
        'a keyset sent that does not parse',
        { cursor: windowToken({ filters: WINDOW_FILTERS, keyset: keyset({ sent: 'yesterday' }) }) },
      ],
      [
        'a keyset sent before start',
        {
          cursor: windowToken({
            filters: WINDOW_FILTERS,
            keyset: keyset({ sent: '2026-11-11T01:59:59Z' }),
          }),
        },
      ],
      [
        'a keyset sent after end',
        {
          cursor: windowToken({
            filters: WINDOW_FILTERS,
            keyset: keyset({ sent: '2026-11-11T03:00:01Z' }),
          }),
        },
      ],
      [
        'empty keyset ids',
        { cursor: windowToken({ filters: WINDOW_FILTERS, keyset: keyset({ ids: [] }) }) },
      ],
      [
        'keyset ids that are not tuples',
        {
          cursor: windowToken({
            filters: WINDOW_FILTERS,
            keyset: keyset({ ids: [`${CAP_PREFIX}${TIE_37}.001.1`] }),
          }),
        },
      ],
      [
        'an empty keyset ID group',
        { cursor: windowToken({ filters: WINDOW_FILTERS, keyset: keyset({ ids: [[]] }) }) },
      ],
      [
        'a keyset with an unknown key',
        { cursor: windowToken({ filters: WINDOW_FILTERS, keyset: keyset({ offset: 3 }) }) },
      ],
      [
        'keyset ids that, with the page and one more, pass 500',
        {
          cursor: windowToken({ filters: WINDOW_FILTERS, keyset: keyset({ ids: looseIds(493) }) }),
        },
      ],
      [
        'a carried start of Feb 30',
        {
          cursor: windowToken({
            filters: { ...WINDOW_FILTERS, start: '2026-02-30T00:00:00Z' },
            keyset: keyset(),
          }),
        },
      ],
      [
        'a carried start after its end',
        {
          cursor: windowToken({
            filters: { ...WINDOW_FILTERS, start: WINDOW.end, end: WINDOW.start },
            keyset: keyset(),
          }),
        },
      ],
    ])('rejects %s as invalid_cursor before any request', async (_label, args) => {
      serveWindow(fixtureAlerts);

      const error = await refused(args);

      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_cursor');
      expect(serviceCalls()).toBe(0);
    });

    it('accepts a keyset whose IDs, with the page and one more, fill one request exactly', async () => {
      serveWindow(fixtureAlerts);

      await call({
        cursor: windowToken({ filters: WINDOW_FILTERS, keyset: keyset({ ids: looseIds(492) }) }),
      });

      expect(windowCalls()).toHaveLength(1);
      expect(windowCalls()[0]?.limit).toBe(500);
    });

    it('serves a windowed token’s carried page size above the cap as 25, budgeting the request on that page', async () => {
      const sent = '2026-11-11T02:37:00Z';
      const seenIds = looseIds(440);
      const unseen = Array.from({ length: 26 }, (_, index) =>
        makeAlert({ id: `urn:test:unseen:${String(index).padStart(2, '0')}`, sent }),
      );
      mockSearchAlertWindow.mockResolvedValueOnce({
        alerts: [...seenIds.map(([id]) => makeAlert({ id, sent })), ...unseen],
      });

      // 440 carried with the 100 it names would pass 500; with the 25 it is served, 466 fits.
      const surfaces = await call({
        cursor: encodeCursor({
          offset: 0,
          limit: 100,
          filters: WINDOW_FILTERS,
          keyset: { sent, ids: seenIds },
        }),
      });

      expect(windowCalls()[0]).toMatchObject({ end: sent, limit: 440 + 25 + 1 });
      expect(ids(surfaces)).toEqual(unseen.slice(0, 25).map((alert) => alert.id));
      expect(decode(surfaces.data.nextCursor)).toMatchObject({ limit: 25 });
    });

    it.each([
      ['{ offset, limit }', encodeCursor({ offset: 3, limit: 3 }), 'national (no filters)'],
      [
        '{ offset, limit, filters }',
        encodeCursor({ offset: 3, limit: 3, filters: { region: ['PA'], status: 'Actual' } }),
        'region=PA',
      ],
    ])(
      'resumes a %s token on the active path, never /alerts',
      async (_label, cursor, appliedFilters) => {
        mockSearchAlerts.mockResolvedValue({
          alerts: Array.from({ length: 8 }, (_, index) => makeAlert({ id: `urn:active:${index}` })),
        });

        const surfaces = await call({ cursor });

        expect(ids(surfaces)).toEqual(['urn:active:3', 'urn:active:4', 'urn:active:5']);
        expect(surfaces.data).toMatchObject({ totalCount: 8, shown: 3, appliedFilters });
        expect(surfaces.data).not.toHaveProperty('window');
        expect(mockSearchAlerts).toHaveBeenCalledTimes(1);
        expect(mockSearchAlertWindow).not.toHaveBeenCalled();
        expect(mockMatchAlertEventTypes).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        'start after end',
        { start: WINDOW.end, end: WINDOW.start },
        `start "${WINDOW.end}" is after end "${WINDOW.start}"`,
      ],
      [
        'a start of Feb 30',
        { start: '2026-02-30T00:00:00Z' },
        'start "2026-02-30T00:00:00Z" is not a valid ISO 8601 date-time',
      ],
      [
        'a date-only start',
        { start: '2026-11-10' },
        'start "2026-11-10" is not a valid ISO 8601 date-time',
      ],
      [
        'a date-only end',
        { end: '2026-11-10' },
        'end "2026-11-10" is not a valid ISO 8601 date-time',
      ],
    ])('refuses %s as invalid_time_window before any request', async (_label, args, message) => {
      serveWindow(fixtureAlerts);

      const error = await refused(args);

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('invalid_time_window');
      expect(error.message).toContain(message);
      expect(serviceCalls()).toBe(0);
    });

    it('orders start and end by instant when their offsets differ', async () => {
      serveWindow(fixtureAlerts);

      // 20:30 CST on Nov 10 is 02:30Z on Nov 11, after an end of 02:00Z, though it reads earlier.
      const inverted = { start: '2026-11-10T20:30:00-06:00', end: '2026-11-11T02:00:00Z' };
      const error = await refused(inverted);
      expect(error.data?.reason).toBe('invalid_time_window');
      expect(error.message).toContain(`start "${inverted.start}" is after end "${inverted.end}"`);
      expect(serviceCalls()).toBe(0);

      // 21:00 EST on Nov 10 is 02:00Z on Nov 11, after a start of 01:00Z, though it reads earlier.
      const ordered = { start: '2026-11-11T01:00:00Z', end: '2026-11-10T21:00:00-05:00' };
      const served = await call(ordered);
      expect(served.data.window).toEqual(ordered);
      expect(windowCalls()).toEqual([expect.objectContaining(ordered)]);
    });

    it.each([
      // 449 + 25 = 474 carried; 474 + 25 + 1 = 500 still fits one request.
      [449, true],
      // 474 + 25 = 499 carried; 499 + 25 + 1 = 525 does not.
      [474, false],
    ])(
      'with %i IDs already returned at the boundary, offers a cursor only while the next request fits 500: %s',
      async (seenCount, continues) => {
        const sent = '2026-11-11T02:37:00Z';
        const seenIds = looseIds(seenCount);
        const unseen = Array.from({ length: 26 }, (_, index) =>
          makeAlert({ id: `urn:test:unseen:${String(index).padStart(2, '0')}`, sent }),
        );
        mockSearchAlertWindow.mockResolvedValueOnce({
          alerts: [...seenIds.map(([id]) => makeAlert({ id, sent })), ...unseen],
        });

        const surfaces = await call({
          cursor: encodeCursor({
            offset: 0,
            limit: 25,
            filters: WINDOW_FILTERS,
            keyset: { sent, ids: seenIds },
          }),
        });

        expect(windowCalls()[0]).toMatchObject({ end: sent, limit: seenCount + 25 + 1 });
        expect(ids(surfaces)).toEqual(unseen.slice(0, 25).map((alert) => alert.id));
        const carried = seenCount + 25;
        if (continues) {
          expect(carriedCount(decode(surfaces.data.nextCursor).keyset!.ids)).toBe(carried);
          expect(surfaces.data.notice).toBe(MORE_REMAIN(25));
        } else {
          const notice = `Returning 25 alert messages, newest first. More remain, but this walk has already returned ${carried} issued at ${sent}, more than one NWS request can page past; narrow the filters, or move end to just before ${sent}, to reach the rest.`;
          expect(surfaces.data).not.toHaveProperty('nextCursor');
          expect(surfaces.data.notice).toBe(notice);
          expect(surfaces.text).toContain(`> ${notice}`);
          expect(surfaces.text).not.toContain('Next Cursor');
        }
      },
    );

    it('ends a walk whose remaining messages are gone with an empty page that says so', async () => {
      // Every message the boundary request returns was already returned.
      const sent = '2026-11-11T02:37:00Z';
      mockSearchAlertWindow.mockResolvedValueOnce({
        alerts: [makeAlert({ id: `${CAP_PREFIX}${TIE_37}.001.1`, sent })],
      });

      const surfaces = await call({
        cursor: windowToken({ filters: WINDOW_FILTERS, keyset: keyset() }),
      });

      const notice = `No alert messages remain past the previous page for: start=${WINDOW.start}, end=${WINDOW.end}. NWS keeps alert messages for 7 days, back to ${CUTOFF}; any that aged out since that page are gone.`;
      expect(surfaces.data.alerts).toEqual([]);
      expect(surfaces.data).not.toHaveProperty('nextCursor');
      expect(surfaces.data).toMatchObject({ shown: 0, notice, window: WINDOW });
      expect(surfaces.text).toContain(
        `No alert messages issued between ${WINDOW.start} and ${WINDOW.end} matched.`,
      );
      expect(surfaces.text).toContain(`> ${notice}`);
    });

    describe('retention notice', () => {
      const EIGHT_DAYS_BACK = '2026-11-03T12:00:00Z';
      const SIX_DAYS_BACK = '2026-11-05T12:00:00Z';
      const RESTART =
        'Widen the window or remove filters, or omit start and end to search the alerts active now.';

      it.each([
        ['with messages', 2, RETENTION],
        [
          'empty',
          0,
          `${RETENTION} No alert messages matched: start=${EIGHT_DAYS_BACK}. ${RESTART}`,
        ],
      ])(
        'flags a window starting 8 days back on both surfaces, %s',
        async (_label, count, notice) => {
          serveWindow(hourly(count, '2026-11-05T00:00:00Z'));

          const surfaces = await call({ start: EIGHT_DAYS_BACK });

          expect(surfaces.data.alerts).toHaveLength(count);
          expect(surfaces.data.notice).toBe(notice);
          expect(surfaces.text).toContain(`> ${notice}`);
        },
      );

      it.each([
        ['with messages', 2, undefined],
        [
          'empty',
          0,
          `No alert messages matched: start=${SIX_DAYS_BACK}. NWS keeps alert messages for 7 days, back to ${CUTOFF}. ${RESTART}`,
        ],
      ])('leaves it off a window starting 6 days back, %s', async (_label, count, notice) => {
        serveWindow(hourly(count, '2026-11-06T00:00:00Z'));

        const surfaces = await call({ start: SIX_DAYS_BACK });

        expect(surfaces.data.alerts).toHaveLength(count);
        expect(surfaces.data.notice).toBe(notice);
        expect(surfaces.text).not.toContain('as far back as NWS keeps');
      });

      it('names the cutoff, without the retention notice, on an end-only window past it', async () => {
        serveWindow([]);

        const surfaces = await call({ end: '2026-11-01T00:00:00Z' });

        expect(surfaces.data.notice).toBe(
          `No alert messages matched: end=2026-11-01T00:00:00Z. NWS keeps alert messages for 7 days, back to ${CUTOFF}. ${RESTART}`,
        );
      });

      it('names the cutoff to the second, and flags only a start before that second, when the clock carries milliseconds', async () => {
        vi.setSystemTime(new Date('2026-11-11T12:00:00.250Z'));
        serveWindow([]);

        const endOnly = await call({ end: '2026-11-01T00:00:00Z' });
        const atCutoff = await call({ start: '2026-11-04T12:00:01Z' });
        const beforeCutoff = await call({ start: '2026-11-04T12:00:00Z' });

        expect(endOnly.data.notice).toBe(
          `No alert messages matched: end=2026-11-01T00:00:00Z. NWS keeps alert messages for 7 days, back to 2026-11-04T12:00:01Z. ${RESTART}`,
        );
        expect(atCutoff.data.notice).not.toContain('as far back as NWS keeps');
        expect(beforeCutoff.data.notice).toContain(
          'This window starts before 2026-11-04T12:00:01Z, about as far back as NWS keeps alert messages (7 days)',
        );
      });

      it('does not claim messages before the cutoff are gone when NWS still serves one', async () => {
        // NWS purges a few minutes behind the 7-day mark, so a message sent just
        // before the cutoff can still come back inside a window that starts earlier.
        serveWindow([
          makeAlert({ id: 'urn:test:kept:001', sent: '2026-11-04T12:30:00Z' }),
          makeAlert({ id: 'urn:test:kept:002', sent: '2026-11-04T11:58:00Z' }),
        ]);

        const surfaces = await call({ start: EIGHT_DAYS_BACK });

        expect(ids(surfaces)).toEqual(['urn:test:kept:001', 'urn:test:kept:002']);
        expect(surfaces.data.notice).toBe(RETENTION);
        expect(surfaces.data.notice).not.toContain('are missing');
      });

      it('carries both when the page also has older messages remaining', async () => {
        serveWindow(hourly(10, '2026-11-05T00:00:00Z'));

        const surfaces = await call({ start: EIGHT_DAYS_BACK, limit: 7 });

        const notice = `${RETENTION} ${MORE_REMAIN(7)}`;
        expect(surfaces.data.nextCursor).toEqual(expect.any(String));
        expect(surfaces.data.notice).toBe(notice);
        expect(surfaces.text).toContain(`> ${notice}`);
      });

      it('carries the limit clamp, the retention notice, and the remaining-messages notice together', async () => {
        serveWindow(hourly(30, '2026-11-05T00:00:00Z'));

        const surfaces = await call({ start: EIGHT_DAYS_BACK, limit: 40 });

        const notice = `Requested limit 40 exceeds the per-page cap of 25; this page holds up to 25. ${RETENTION} ${MORE_REMAIN(25)}`;
        expect(surfaces.data).toMatchObject({ requestedLimit: 40, effectiveLimit: 25, shown: 25 });
        expect(surfaces.data.notice).toBe(notice);
        expect(surfaces.text).toContain(`> ${notice}`);
      });

      it('carries both beside an event that matches no type, sending no /alerts request', async () => {
        mockMatchAlertEventTypes.mockResolvedValueOnce([]);

        const surfaces = await call({ start: EIGHT_DAYS_BACK, event: ['zzz'] });

        const notice = `${RETENTION} No NWS alert event type matches event=zzz, so no message can match. Use nws_list_alert_types to find valid event names.`;
        expect(surfaces.data.alerts).toEqual([]);
        expect(surfaces.data.notice).toBe(notice);
        expect(surfaces.text).toContain(`> ${notice}`);
        expect(mockMatchAlertEventTypes).toHaveBeenCalledWith(['zzz'], expect.anything());
        expect(mockSearchAlertWindow).not.toHaveBeenCalled();
      });
    });

    it('passes message_type to the active search', async () => {
      mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

      const surfaces = await call({ message_type: 'Update' });

      expect(mockSearchAlerts).toHaveBeenCalledWith(
        expect.objectContaining({ message_type: 'Update' }),
        expect.anything(),
      );
      expect(mockSearchAlertWindow).not.toHaveBeenCalled();
      expect(surfaces.data.appliedFilters).toBe('message_type=Update');
    });

    it('passes message_type to the windowed search, on the first page and every continued one', async () => {
      serveWindow(fixtureAlerts);

      const first = await call({ ...WINDOW, message_type: 'Cancel', limit: 7 });
      await call({ cursor: first.data.nextCursor });

      expect(windowCalls().map((params) => params.message_type)).toEqual(['Cancel', 'Cancel']);
      expect(decode(first.data.nextCursor).filters).toMatchObject({ message_type: 'Cancel' });
      expect(first.data.appliedFilters).toBe(
        `message_type=Cancel, start=${WINDOW.start}, end=${WINDOW.end}`,
      );
      expect(mockSearchAlerts).not.toHaveBeenCalled();
    });

    it('reports shown without totalCount on a windowed search, where an active search reports both', async () => {
      serveWindow(fixtureAlerts);
      mockSearchAlerts.mockResolvedValueOnce({ alerts: fixtureAlerts });

      const windowed = await call({ ...WINDOW, limit: 7 });
      const active = await call({ limit: 7 });

      expect(windowed.data).not.toHaveProperty('totalCount');
      expect(windowed.data.shown).toBe(7);
      expect(windowed.text).not.toContain('Total Alerts');
      expect(active.data).toMatchObject({ totalCount: 51, shown: 7 });
      expect(active.text).toContain('Total Alerts');
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
