/**
 * @fileoverview Tests for nws_get_office_discussion tool.
 * @module tests/tools/get-office-discussion
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

const discussionResult: OfficeDiscussionResult = {
  issuanceTime: '2026-05-30T10:33:00+00:00',
  issuingOffice: 'KSEW',
  productCode: 'AFD',
  productName: 'Area Forecast Discussion',
  productText:
    'FXUS66 KSEW 301033\nAFDSEW\n\nArea Forecast Discussion\nNational Weather Service Seattle WA\n...\n.SYNOPSIS...\nA warm and dry pattern moves in Monday.',
  wmoCollectiveId: 'FXUS66',
};

describe('nws_get_office_discussion', () => {
  beforeEach(() => {
    mockGetOfficeDiscussion.mockReset();
  });

  it('parses input with default product_type', () => {
    const input = getOfficeDiscussionTool.input.parse({ office: 'SEW' });
    expect(input.office).toBe('SEW');
    expect(input.product_type).toBe('AFD');
  });

  it('accepts valid product_type values', () => {
    for (const type of ['AFD', 'HWO', 'ZFP', 'SPS'] as const) {
      const input = getOfficeDiscussionTool.input.parse({ office: 'SEW', product_type: type });
      expect(input.product_type).toBe(type);
    }
  });

  it('rejects invalid product_type', () => {
    expect(() =>
      getOfficeDiscussionTool.input.parse({ office: 'SEW', product_type: 'FOO' }),
    ).toThrow();
  });

  it('returns discussion with all fields', async () => {
    mockGetOfficeDiscussion.mockResolvedValueOnce(discussionResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getOfficeDiscussionTool.input.parse({ office: 'SEW' });
    const result = await getOfficeDiscussionTool.handler(input, ctx);

    expect(result.issuanceTime).toBe('2026-05-30T10:33:00+00:00');
    expect(result.issuingOffice).toBe('KSEW');
    expect(result.productCode).toBe('AFD');
    expect(result.productName).toBe('Area Forecast Discussion');
    expect(result.productText).toContain('SYNOPSIS');
    expect(result.wmoCollectiveId).toBe('FXUS66');
  });

  it('uppercases office before passing to service', async () => {
    mockGetOfficeDiscussion.mockResolvedValueOnce(discussionResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getOfficeDiscussionTool.input.parse({ office: 'sew', product_type: 'AFD' });
    await getOfficeDiscussionTool.handler(input, ctx);

    expect(mockGetOfficeDiscussion).toHaveBeenCalledWith('SEW', 'AFD', ctx);
  });

  it('propagates the unknown-office no_products error', async () => {
    mockGetOfficeDiscussion.mockRejectedValueOnce(
      new Error('No AFD products found for office "BOGUS". Verify the 3-letter WFO code'),
    );

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getOfficeDiscussionTool.input.parse({ office: 'BOGUS' });
    await expect(getOfficeDiscussionTool.handler(input, ctx)).rejects.toThrow(
      'Verify the 3-letter WFO code',
    );
  });

  it('propagates the valid-office no-current-product error for episodic types', async () => {
    mockGetOfficeDiscussion.mockRejectedValueOnce(
      new Error(
        'No SPS products are currently available for office "SEW". SPS products are episodic',
      ),
    );

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getOfficeDiscussionTool.input.parse({ office: 'SEW', product_type: 'SPS' });
    await expect(getOfficeDiscussionTool.handler(input, ctx)).rejects.toThrow(
      'currently available',
    );
  });

  describe('format', () => {
    it('renders header and product text', () => {
      const blocks = getOfficeDiscussionTool.format!(discussionResult);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Area Forecast Discussion');
      expect(text).toContain('AFD');
      expect(text).toContain('KSEW');
      expect(text).toContain('FXUS66');
      expect(text).toContain('SYNOPSIS');
    });
  });
});
