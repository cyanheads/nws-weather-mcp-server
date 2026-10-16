/**
 * @fileoverview Tests for nws_get_office_discussion tool.
 * @module tests/tools/get-office-discussion
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it('rejects empty office', () => {
    expect(() => getOfficeDiscussionTool.input.parse({ office: '' })).toThrow();
  });

  it('rejects whitespace-only office', () => {
    expect(() => getOfficeDiscussionTool.input.parse({ office: '   ' })).toThrow();
  });

  it('rejects invalid product_type', () => {
    expect(() =>
      getOfficeDiscussionTool.input.parse({ office: 'SEW', product_type: 'FOO' }),
    ).toThrow();
  });

  it('returns discussion with all fields', async () => {
    mockGetOfficeDiscussion.mockResolvedValueOnce(discussionResult);

    const ctx = createMockContext({ tenantId: 'test', errors: getOfficeDiscussionTool.errors });
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

    const ctx = createMockContext({ tenantId: 'test', errors: getOfficeDiscussionTool.errors });
    const input = getOfficeDiscussionTool.input.parse({ office: 'sew', product_type: 'AFD' });
    await getOfficeDiscussionTool.handler(input, ctx);

    expect(mockGetOfficeDiscussion).toHaveBeenCalledWith('SEW', 'AFD', ctx);
  });

  it('propagates the unknown-office no_products error', async () => {
    mockGetOfficeDiscussion.mockRejectedValueOnce(
      new Error('No AFD products found for office "BOGUS". Verify the 3-letter WFO code'),
    );

    const ctx = createMockContext({ tenantId: 'test', errors: getOfficeDiscussionTool.errors });
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

    const ctx = createMockContext({ tenantId: 'test', errors: getOfficeDiscussionTool.errors });
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

describe('nws_get_office_discussion — bounded output and sections (issue #50)', () => {
  const BUDGET = 24_000;
  const loadProduct = (name: string): OfficeDiscussionResult =>
    JSON.parse(
      readFileSync(new URL(`../fixtures/products/${name}.json`, import.meta.url), 'utf8'),
    ) as OfficeDiscussionResult;
  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
  const textOf = (result: { content: unknown[] }) =>
    (result.content as { type: string; text?: string }[])
      .map((block) => block.text ?? '')
      .join('\n');
  const call = async (product: OfficeDiscussionResult, args: Record<string, unknown>) => {
    mockGetOfficeDiscussion.mockResolvedValueOnce(product);
    const result = await runToolContract(getOfficeDiscussionTool, {
      office: product.issuingOffice.slice(1),
      product_type: product.productCode,
      ...args,
    });
    return {
      result,
      structured: result.structuredContent as Record<string, unknown>,
      text: textOf(result),
    };
  };
  /** The product's lines that start a UGC segment (`WAZ315-162300-`). */
  const ugcLines = (text: string) =>
    text.split('\n').filter((line) => /^[A-Z]{2}Z\d{3}[->]/.test(line));

  beforeEach(() => {
    mockGetOfficeDiscussion.mockReset();
  });

  it('outlines an over-budget ZFP instead of returning its text', async () => {
    const sewZfp = loadProduct('sew-zfp');
    const { result, structured, text } = await call(sewZfp, {});

    expect(result.isError).toBeFalsy();
    expect(structured.productText).toBeUndefined();
    const outline = structured.outline as { name: string; label?: string; bytes: number }[];
    expect(outline).toHaveLength(34);
    expect(outline).toContainEqual({ name: 'WAZ315', label: 'City of Seattle', bytes: 1508 });
    // Largest first.
    const sizes = outline.map((row) => row.bytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(structured).toMatchObject({
      issuanceTime: '2026-10-16T09:37:00+00:00',
      issuingOffice: 'KSEW',
      productCode: 'ZFP',
      wmoCollectiveId: 'FPUS56',
    });
    // The worked re-call names the largest section that fits the budget with the header.
    expect(structured.notice).toBe(
      'This ZFP is 55764 bytes, over the 24000-byte response budget, so its 34 sections are outlined instead of returned. Re-call with the same office and product_type plus sections:["WAZ302"] to get that section (2106 bytes) with the product header. A selection returns the 244-byte product header and closing lines plus every section it names whole, so add up the listed sizes before naming several.',
    );
    expect(outline[0]).toMatchObject({ name: 'WAZ302', bytes: 2106 });

    // Both surfaces carry the outline and the notice, and each fits the budget.
    expect(text).toContain('**34 sections** (largest first):');
    expect(text).toContain('- `WAZ315` — City of Seattle — 1508 bytes\n');
    expect(text).toContain(structured.notice as string);
    expect(text).not.toContain('.TODAY...');
    expect(bytes(JSON.stringify(structured))).toBeLessThanOrEqual(BUDGET);
    expect(bytes(text)).toBeLessThanOrEqual(BUDGET);
  });

  it('keeps the outline of the largest sampled ZFP under budget on both surfaces', async () => {
    const { structured, text } = await call(loadProduct('akq-zfp'), {});
    expect((structured.outline as unknown[]).length).toBe(67);
    expect(bytes(JSON.stringify(structured))).toBeLessThanOrEqual(BUDGET);
    expect(bytes(text)).toBeLessThanOrEqual(BUDGET);
  });

  it("returns exactly the section the outline notice's worked re-call names", async () => {
    const sewZfp = loadProduct('sew-zfp');
    const outlined = await call(sewZfp, {});
    const named = /sections:\["([^"]+)"\]/.exec(outlined.structured.notice as string)?.[1];
    expect(named).toBe('WAZ302');
    const row = (outlined.structured.outline as { name: string; bytes: number }[]).find(
      (entry) => entry.name === named,
    );
    expect(row).toBeDefined();
    expect(outlined.structured.notice).toContain(`(${row?.bytes} bytes)`);
    const frame = /returns the (\d+)-byte product header and closing lines/.exec(
      outlined.structured.notice as string,
    )?.[1];
    expect(frame).toBe('244');

    const selected = await call(sewZfp, { sections: [named] });
    const productText = selected.structured.productText as string;
    // The notice's sizes add up to what a selection returns.
    expect(bytes(productText)).toBe(Number(frame) + (row?.bytes ?? 0));
    expect(ugcLines(productText)).toEqual([`${named}-162300-`]);
    expect(selected.structured.outline).toBeUndefined();
    expect(selected.text).toContain(productText);
    expect(selected.structured.notice).toBe(
      `Returned 1 of 34 sections with the product header: ${named}. Omit sections for the whole product.`,
    );
    expect(selected.text).toContain(selected.structured.notice as string);
  });

  it('selects one zone segment, UGC line through $$, after the product header', async () => {
    const sewZfp = loadProduct('sew-zfp');
    const { structured } = await call(sewZfp, { sections: ['waz315'] });
    const productText = structured.productText as string;

    expect(
      productText.startsWith(
        sewZfp.productText.slice(0, sewZfp.productText.indexOf('WAZ315-')).trimEnd(),
      ),
    ).toBe(true);
    const segmentStart = sewZfp.productText.indexOf('WAZ315-162300-');
    const segmentEnd = sewZfp.productText.indexOf('$$', segmentStart) + 2;
    expect(productText.endsWith(sewZfp.productText.slice(segmentStart, segmentEnd))).toBe(true);
    expect(ugcLines(productText)).toEqual(['WAZ315-162300-']);
  });

  it('selects a segment by a zone inside a UGC range or a multi-prefix UGC line', async () => {
    const key = await call(loadProduct('key-zfp'), { sections: ['FLZ077'] });
    expect(ugcLines(key.structured.productText as string)).toEqual(['FLZ076>078-162145-']);
    expect(key.structured.notice).toBe(
      'Returned 1 of 1 sections with the product header: FLZ076>078. Omit sections for the whole product.',
    );

    const otx = await call(loadProduct('otx-zfp'), { sections: ['WAZ037'] });
    expect(ugcLines(otx.structured.productText as string)).toEqual(['IDZ001-WAZ037-162300-']);
    expect(otx.structured.notice).toBe(
      'Returned 1 of 14 sections with the product header: IDZ001, WAZ037. Omit sections for the whole product.',
    );
  });

  it('selects a segment by a zone on the wrapped second line of a UGC line', async () => {
    const { structured } = await call(loadProduct('lot-hwo'), { sections: ['INZ019'] });
    const productText = structured.productText as string;
    expect(productText).toContain(
      'ILZ003>006-008-010>013-019>021-023-032-033-039-103>108-INZ001-002-\n010-011-019-170800-',
    );
    expect(productText).not.toContain('LMZ740>745');
    // Every zone of both UGC lines is parsed into the segment's name.
    expect(structured.notice).toBe(
      'Returned 1 of 2 sections with the product header: ILZ003>006, ILZ008, ILZ010>013, ILZ019>021, ILZ023, ILZ032, ILZ033, ILZ039, ILZ103>108, INZ001, INZ002, INZ010, INZ011, INZ019. Omit sections for the whole product.',
    );
  });

  it('returns the header and the whole named AFD section, case-insensitively', async () => {
    const boxAfd = loadProduct('box-afd');
    const { structured, text } = await call(boxAfd, { sections: ['discussion'] });
    const productText = structured.productText as string;

    const start = boxAfd.productText.indexOf('.DISCUSSION...');
    const end = boxAfd.productText.indexOf('.AVIATION /12Z');
    expect(productText).toContain(boxAfd.productText.slice(start, end).trimEnd());
    // The product's closing lines (here the per-section forecaster credits) follow the selection.
    expect(
      productText.endsWith('$$\n\nDISCUSSION...Hrencecin\nAVIATION...Frank\nMARINE...Hrencecin'),
    ).toBe(true);
    // The product header, verbatim, opens the selection.
    const header = boxAfd.productText
      .slice(0, boxAfd.productText.indexOf('.WHAT HAS CHANGED'))
      .trimEnd();
    expect(header.endsWith('759 AM EDT Fri Oct 16 2026')).toBe(true);
    expect(productText.startsWith(`${header}\n\n.DISCUSSION...`)).toBe(true);
    expect(productText).not.toContain('.KEY MESSAGES...');
    expect(productText).not.toContain('.AVIATION');
    expect(structured.notice).toBe(
      'Returned 1 of 6 sections with the product header: DISCUSSION. Omit sections for the whole product.',
    );
    expect(text).toContain(structured.notice as string);
  });

  it('returns several named sections in product order', async () => {
    const { structured } = await call(loadProduct('box-afd'), {
      sections: ['MARINE', 'key messages'],
    });
    const productText = structured.productText as string;
    expect(productText.indexOf('.KEY MESSAGES...')).toBeGreaterThan(-1);
    expect(productText.indexOf('.KEY MESSAGES...')).toBeLessThan(productText.indexOf('.MARINE...'));
    expect(structured.notice).toBe(
      'Returned 2 of 6 sections with the product header: KEY MESSAGES; MARINE. Omit sections for the whole product.',
    );
  });

  it('fails with unknown_section naming the available sections', async () => {
    const { result, text } = await call(loadProduct('box-afd'), { sections: ['NOPE', 'AVIATION'] });
    const message =
      'No section of the latest BOX AFD matches "NOPE". Available sections: "WHAT HAS CHANGED", "KEY MESSAGES", "DISCUSSION", "AVIATION", "MARINE", "BOX WATCHES/WARNINGS/ADVISORIES".';
    const hint =
      'Re-call with names from the available sections this error lists, or omit sections to get the whole product (or its outline when it is too large).';

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: {
          reason: 'unknown_section',
          unmatched: ['NOPE'],
          available: [
            'WHAT HAS CHANGED',
            'KEY MESSAGES',
            'DISCUSSION',
            'AVIATION',
            'MARINE',
            'BOX WATCHES/WARNINGS/ADVISORIES',
          ],
          recovery: { hint },
        },
      },
    });
    expect(text).toContain(message);
    expect(text).toContain(`Recovery: ${hint}`);
  });

  it('lists each zone segment with its area name when unknown_section fails on a ZFP', async () => {
    const { result, text } = await call(loadProduct('sew-zfp'), { sections: ['Seattle'] });
    expect(result.isError).toBe(true);
    expect(text).toContain('"WAZ315" (City of Seattle)');
    const { data } = (
      result.structuredContent as {
        error: { data: { reason: string; unmatched: string[]; available: string[] } };
      }
    ).error;
    expect(data.reason).toBe('unknown_section');
    expect(data.unmatched).toEqual(['Seattle']);
    expect(data.available).toHaveLength(34);
    expect(data.available).toContain('WAZ315');
  });

  it('fails with unknown_section when the product has no sections at all', async () => {
    const flat: OfficeDiscussionResult = {
      ...loadProduct('box-afd'),
      productText: 'FXUS61 KBOX 161159\nAFDBOX\n\nNo headers in this product.',
    };
    const { result, text } = await call(flat, { sections: ['DISCUSSION'] });
    const message =
      'No section of the latest BOX AFD matches "DISCUSSION". This product has no sections to select; omit sections to get it whole.';
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: { reason: 'unknown_section', unmatched: ['DISCUSSION'], available: [] },
      },
    });
    expect(text).toContain(message);
  });

  it('returns an under-budget AFD byte-identical to the pre-outline output', async () => {
    const wire = JSON.parse(
      readFileSync(new URL('../fixtures/products/sew-afd.wire.json', import.meta.url), 'utf8'),
    ) as { structuredContent: OfficeDiscussionResult; content: unknown[] };
    const { result } = await call(wire.structuredContent, {});
    expect(result.structuredContent).toEqual(wire.structuredContent);
    expect(result.content).toEqual(wire.content);
  });

  it.each([[[]], [['']], [['   ', '']]])('treats sections %j as omitted', async (sections) => {
    const wire = JSON.parse(
      readFileSync(new URL('../fixtures/products/sew-afd.wire.json', import.meta.url), 'utf8'),
    ) as { structuredContent: OfficeDiscussionResult; content: unknown[] };
    const afd = await call(wire.structuredContent, { sections });
    expect(afd.result.structuredContent).toEqual(wire.structuredContent);
    expect(afd.result.content).toEqual(wire.content);

    const zfp = await call(loadProduct('sew-zfp'), { sections });
    expect(zfp.structured.outline).toHaveLength(34);
    expect(zfp.structured.productText).toBeUndefined();
  });

  it('returns a product with fewer than two sections whole at any size', async () => {
    const key = loadProduct('key-zfp');
    const body = `${'.TODAY...Sunny and warm. '.repeat(1_200)}\n$$`;
    const oversized: OfficeDiscussionResult = {
      ...key,
      productText: `${key.productText.slice(0, key.productText.indexOf('$$'))}${body}`,
    };
    expect(bytes(oversized.productText)).toBeGreaterThan(BUDGET);

    const { structured, text } = await call(oversized, {});
    expect(structured.productText).toBe(oversized.productText);
    expect(structured.outline).toBeUndefined();
    expect(structured.notice).toBeUndefined();
    expect(text).toContain(oversized.productText);
  });

  it('bounds sections at 100 entries of up to 200 characters', () => {
    const parse = (sections: string[]) =>
      getOfficeDiscussionTool.input.safeParse({ office: 'SEW', sections }).success;
    expect(parse(Array.from({ length: 100 }, () => 'WAZ315'))).toBe(true);
    expect(parse(Array.from({ length: 101 }, () => 'WAZ315'))).toBe(false);
    expect(parse(['A'.repeat(200)])).toBe(true);
    expect(parse(['A'.repeat(201)])).toBe(false);
  });

  it('names no section in the notice when none fits the budget', async () => {
    const hugeSection = (name: string) =>
      `.${name}...\n${'Forecast reasoning text. '.repeat(1_100)}\n\n&&`;
    const product: OfficeDiscussionResult = {
      ...loadProduct('box-afd'),
      productText: `FXUS61 KBOX 161159\nAFDBOX\n\n${hugeSection('DISCUSSION')}\n\n${hugeSection('AVIATION')}\n\n$$`,
    };
    const { structured } = await call(product, {});
    expect(structured.outline).toEqual([
      { name: 'DISCUSSION', bytes: 27519 },
      { name: 'AVIATION', bytes: 27517 },
    ]);
    expect(structured.notice).toBe(
      'This AFD is 55254 bytes, over the 24000-byte response budget, so its 2 sections are outlined instead of returned. No single section fits the budget (the smallest is 27517 bytes); a sections:[...] selection still returns whole at any size.',
    );
  });
});
