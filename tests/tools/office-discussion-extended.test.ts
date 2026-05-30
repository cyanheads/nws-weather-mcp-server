/**
 * @fileoverview Extended tests for nws_get_office_discussion: enrichment, edge cases, format.
 * @module tests/tools/office-discussion-extended
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeDiscussionResult } from '@/services/nws/nws-service.js';

const mockGetOfficeDiscussion = vi.fn<() => Promise<OfficeDiscussionResult>>();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({ getOfficeDiscussion: mockGetOfficeDiscussion }),
}));

const { getOfficeDiscussionTool } = await import(
  '@/mcp-server/tools/definitions/get-office-discussion.tool.js'
);

const baseResult: OfficeDiscussionResult = {
  issuanceTime: '2026-05-30T10:33:00+00:00',
  issuingOffice: 'KSEW',
  productCode: 'AFD',
  productName: 'Area Forecast Discussion',
  productText:
    'FXUS66 KSEW 301033\nAFDSEW\n\nArea Forecast Discussion\nNWS Seattle WA\n.SYNOPSIS...\nDry pattern continues.',
  wmoCollectiveId: 'FXUS66',
};

describe('nws_get_office_discussion extended', () => {
  beforeEach(() => {
    mockGetOfficeDiscussion.mockReset();
  });

  describe('handler — normalization', () => {
    it('trims whitespace from office before calling service', async () => {
      mockGetOfficeDiscussion.mockResolvedValueOnce(baseResult);

      const ctx = createMockContext({ tenantId: 'test' });
      const input = getOfficeDiscussionTool.input.parse({ office: '  sew  ' });
      await getOfficeDiscussionTool.handler(input, ctx);

      expect(mockGetOfficeDiscussion).toHaveBeenCalledWith('SEW', 'AFD', ctx);
    });

    it('passes all valid product_type values to service', async () => {
      for (const type of ['AFD', 'HWO', 'ZFP', 'SPS'] as const) {
        mockGetOfficeDiscussion.mockResolvedValueOnce({ ...baseResult, productCode: type });

        const ctx = createMockContext({ tenantId: 'test' });
        const input = getOfficeDiscussionTool.input.parse({ office: 'SEW', product_type: type });
        const result = await getOfficeDiscussionTool.handler(input, ctx);

        expect(mockGetOfficeDiscussion).toHaveBeenCalledWith('SEW', type, ctx);
        expect(result.productCode).toBe(type);
      }
    });
  });

  describe('handler — output shape', () => {
    it('returns all required fields', async () => {
      mockGetOfficeDiscussion.mockResolvedValueOnce(baseResult);

      const ctx = createMockContext({ tenantId: 'test' });
      const input = getOfficeDiscussionTool.input.parse({ office: 'SEW' });
      const result = await getOfficeDiscussionTool.handler(input, ctx);

      expect(result).toMatchObject({
        issuanceTime: '2026-05-30T10:33:00+00:00',
        issuingOffice: 'KSEW',
        productCode: 'AFD',
        productName: 'Area Forecast Discussion',
        wmoCollectiveId: 'FXUS66',
      });
      expect(result.productText).toContain('SYNOPSIS');
    });

    it('logs at info level on success (no crash)', async () => {
      mockGetOfficeDiscussion.mockResolvedValueOnce(baseResult);
      const ctx = createMockContext({ tenantId: 'test' });
      const input = getOfficeDiscussionTool.input.parse({ office: 'BOU' });
      await expect(getOfficeDiscussionTool.handler(input, ctx)).resolves.toBeDefined();
    });
  });

  describe('format', () => {
    it('renders product name, code, issuing office, and WMO ID in header', () => {
      const blocks = getOfficeDiscussionTool.format!(baseResult);
      const t = (blocks[0] as { type: 'text'; text: string }).text;

      expect(t).toContain('## Area Forecast Discussion (AFD)');
      expect(t).toContain('KSEW');
      expect(t).toContain('FXUS66');
      expect(t).toContain('2026-05-30T10:33:00+00:00');
    });

    it('renders full product text verbatim', () => {
      const blocks = getOfficeDiscussionTool.format!(baseResult);
      const t = (blocks[0] as { type: 'text'; text: string }).text;

      expect(t).toContain('SYNOPSIS');
      expect(t).toContain('Dry pattern continues');
    });

    it('renders HWO product name correctly', () => {
      const hwoResult: OfficeDiscussionResult = {
        ...baseResult,
        productCode: 'HWO',
        productName: 'Hazardous Weather Outlook',
        wmoCollectiveId: 'FLUS44',
      };
      const blocks = getOfficeDiscussionTool.format!(hwoResult);
      const t = (blocks[0] as { type: 'text'; text: string }).text;
      expect(t).toContain('## Hazardous Weather Outlook (HWO)');
      expect(t).toContain('FLUS44');
    });

    it('handles empty product text without crashing', () => {
      const emptyText: OfficeDiscussionResult = { ...baseResult, productText: '' };
      const blocks = getOfficeDiscussionTool.format!(emptyText);
      const t = (blocks[0] as { type: 'text'; text: string }).text;
      expect(t).toContain('Area Forecast Discussion');
    });
  });

  describe('error propagation', () => {
    it('propagates no_products error when service throws', async () => {
      const err = new Error('No HWO products found for office "KSEW"');
      mockGetOfficeDiscussion.mockRejectedValueOnce(err);

      const ctx = createMockContext({ tenantId: 'test' });
      const input = getOfficeDiscussionTool.input.parse({ office: 'SEW', product_type: 'HWO' });
      await expect(getOfficeDiscussionTool.handler(input, ctx)).rejects.toThrow('No HWO products');
    });

    it('propagates service-level errors from unexpected upstream failures', async () => {
      const err = new Error('Unexpected failure');
      mockGetOfficeDiscussion.mockRejectedValueOnce(err);

      const ctx = createMockContext({ tenantId: 'test' });
      const input = getOfficeDiscussionTool.input.parse({ office: 'SEW' });
      await expect(getOfficeDiscussionTool.handler(input, ctx)).rejects.toThrow(
        'Unexpected failure',
      );
    });
  });
});
