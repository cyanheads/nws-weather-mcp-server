/**
 * @fileoverview Tool: nws_get_office_discussion — fetches the latest narrative product from a
 * Weather Forecast Office. A product too large to inline comes back as an outline of its
 * sections, and `sections` selects AFD sections or zone segments from any product.
 * @module mcp-server/tools/definitions/get-office-discussion
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DEFAULT_OUTLINE_BUDGET_BYTES,
  escapeMarkdownInline,
  markdown,
} from '@cyanheads/mcp-ts-core/utils';
import { getNwsService } from '@/services/nws/nws-service.js';
import {
  type ProductPart,
  partitionProduct,
  partMatches,
} from '@/services/nws/product-sections.js';

/**
 * Office code shape advertised as a JSON Schema `pattern` (issue #54): 2–3 letters
 * or digits in any case, with surrounding whitespace, which the schema trims. Every
 * NWS product location is one ("SEW", "PR", "PQ1"); a malformed code still fails in
 * the service as no_products.
 */
export const OFFICE_INPUT_PATTERN = /^\s*[A-Za-z0-9]{2,3}\s*$/;

/** Per-surface byte budget past which a product is outlined instead of inlined. */
const BUDGET_BYTES = DEFAULT_OUTLINE_BUDGET_BYTES;

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

interface DiscussionView {
  issuanceTime: string;
  issuingOffice: string;
  outline?: { bytes: number; label?: string | undefined; name: string }[] | undefined;
  productCode: string;
  productName: string;
  productText?: string | undefined;
  wmoCollectiveId: string;
}

/**
 * The `content[0]` text, and the rendered surface the outline budget measures. Product
 * text goes in one `text` code block whose backtick fence outgrows any run inside it,
 * so a CommonMark client keeps NWS's fixed-width columns and indents verbatim.
 */
function renderText(result: DiscussionView): string {
  const lines = [
    `## ${escapeMarkdownInline(result.productName)} (${escapeMarkdownInline(result.productCode)})`,
    `**Office:** ${escapeMarkdownInline(result.issuingOffice)} | **Issued:** ${escapeMarkdownInline(result.issuanceTime)} | **WMO ID:** ${escapeMarkdownInline(result.wmoCollectiveId)}`,
  ];
  if (result.productText !== undefined) {
    lines.push('', markdown().codeBlock(result.productText, 'text').build());
  }
  if (result.outline) {
    lines.push('', `**${result.outline.length} sections** (largest first):`, '');
    for (const row of result.outline) {
      lines.push(
        `- ${markdown().inlineCode(row.name).build()}${row.label ? ` — ${escapeMarkdownInline(row.label)}` : ''} — ${row.bytes} bytes`,
      );
    }
  }
  return lines.join('\n');
}

/** The identifier a worked re-call names: an AFD section name, or a segment's first zone code. */
function selectorFor(part: ProductPart): string {
  const [first] = part.zones;
  return first ? `${first.prefix}${String(first.from).padStart(3, '0')}` : part.name;
}

export const getOfficeDiscussionTool = tool('nws_get_office_discussion', {
  description:
    'Get the latest narrative forecast product from a Weather Forecast Office (WFO). The default product is AFD (Area Forecast Discussion), which explains the meteorological reasoning behind the forecast — synoptic setup, model guidance, and forecaster confidence. Other types: HWO (Hazardous Weather Outlook, 1-7 day severe/flood/winter outlook), ZFP (Zone Forecast Product, zone-by-zone text), SPS (Special Weather Statement, short-fuse advisory), FWF (Fire Weather Planning Forecast, one segment per fire weather zone). The office code is the 3-letter WFO identifier returned as the "office" field by nws_get_forecast. A product over 24,000 bytes (most ZFPs and FWFs) comes back as an outline of its sections — AFD section names, or ZFP/HWO/SPS/FWF zone segments with their area names — with each section\'s size, instead of the text; re-call with sections to get the ones you need. sections also works on a product of any size, to read one AFD section or one zone\'s forecast. For an alert zone typed "fire" (Red Flag Warning, Fire Weather Watch), pass the alert\'s "office" field as office, product_type "FWF", and the zone code in sections.',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'no_products',
      code: JsonRpcErrorCode.NotFound,
      when: 'Office code is unknown, or no product of the requested type is filed under it: episodic types (SPS, HWO) are commonly empty, some offices file AFD or ZFP under other location codes, and some offices issue no FWF',
      recovery:
        'For SPS or HWO, retry with product_type "AFD" — episodic types are issued only when conditions warrant. For ZFP, retry with the location code the office files under (Anchorage: "AER" or "ALU"; San Juan: "PR"), or use nws_get_zone_forecast for one zone\'s text forecast. For FWF, retry with product_type "AFD", or with the office in a fire weather alert\'s "office" field. If the code may be wrong, find the WFO code in the "office" field of nws_get_forecast output.',
      // An unknown office or no current product is an answer, not a fault.
      severity: 'notice',
      // Raised by the NWS service layer, which branches the hint on whether the
      // office probe resolves — not by a `ctx.fail` in this handler.
      thrownBy: 'service',
    },
    {
      reason: 'unknown_section',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A sections entry matches no section of the latest product',
      recovery:
        'Re-call with names from the available sections this error lists, or omit sections to get the whole product (or its outline when it is too large).',
      severity: 'notice',
    },
  ],

  input: z.object({
    office: z
      .string()
      .trim()
      .min(1)
      .meta({ pattern: OFFICE_INPUT_PATTERN.source })
      .describe(
        'Product location code of 2–3 letters or digits, case-insensitive — usually the 3-letter Weather Forecast Office (WFO) code (e.g., "SEW" for Seattle, "LOX" for Los Angeles), returned as the "office" field in nws_get_forecast output. Some offices file a product under other codes: Anchorage files its ZFP under "AER" (Anchorage East) and "ALU" (Anchorage West), not "AFC"; San Juan files its ZFP under "PR", and Guam its SPS under "PQ1".',
      ),
    // A form client's blank "" takes the AFD default instead of failing the enum
    // (issue #46); the advertised schema is the inner enum's.
    product_type: z
      .preprocess(
        (value) => (value === '' ? undefined : value),
        z.enum(['AFD', 'HWO', 'ZFP', 'SPS', 'FWF']).default('AFD'),
      )
      .describe(
        'Product type code. AFD (Area Forecast Discussion) — meteorological reasoning, model analysis, forecaster confidence. HWO (Hazardous Weather Outlook) — 1-7 day outlook for severe weather, flooding, winter weather. ZFP (Zone Forecast Product) — detailed zone-by-zone text forecast. SPS (Special Weather Statement) — short-fuse advisory for notable non-warning weather. FWF (Fire Weather Planning Forecast) — fire weather discussion plus a forecast segment per fire weather zone (e.g., humidity and wind); select a zone with sections.',
      ),
    sections: z
      .array(z.string().max(200))
      .max(100)
      .optional()
      .describe(
        'Sections to return instead of the whole product: AFD section names, case-insensitive (e.g., "DISCUSSION", "AVIATION"), or zone codes for ZFP/HWO/SPS/FWF (e.g., "WAZ315"; a code inside a listed range such as FLZ076>078 selects that segment). Take names from the outline. Returns the product header plus every matching section verbatim, in product order, followed by the product\'s closing lines (forecaster credits, links). Omit for the whole product, or its outline when it is too large.',
      ),
  }),

  output: z.object({
    issuanceTime: z
      .string()
      .describe('When the product was issued (ISO 8601), e.g., "2026-05-30T10:33:00+00:00".'),
    issuingOffice: z
      .string()
      .describe(
        'Issuing office call sign (e.g., "KSEW"). Includes the K/P prefix, unlike the input office code.',
      ),
    productCode: z.string().describe('Product type code (e.g., "AFD").'),
    productName: z.string().describe('Full product name (e.g., "Area Forecast Discussion").'),
    productText: z
      .string()
      .optional()
      .describe(
        'Narrative product text as issued by the forecaster: the whole product, or the product header followed by each selected section when sections was given. Absent when outline is returned.',
      ),
    outline: z
      .array(
        z
          .object({
            name: z
              .string()
              .describe(
                'AFD section name (e.g., "AVIATION"), or a zone segment\'s zone codes as issued, ranges written NNN>MMM (e.g., "FLZ076>078, IDZ001"). Pass it, or any one zone code it covers, in sections.',
              ),
            label: z
              .string()
              .optional()
              .describe('Area name line of a zone segment (e.g., "City of Seattle").'),
            bytes: z.number().describe('Size of the section text in bytes.'),
          })
          .describe('One section of the product'),
      )
      .optional()
      .describe(
        'Sections of a product too large to inline, largest first. Present only in place of productText.',
      ),
    wmoCollectiveId: z
      .string()
      .describe(
        'WMO collective identifier (e.g., "FXUS66"). Identifies the product family in international message routing.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Set when the product is outlined (with a worked sections re-call) or when sections selected part of it (how many of how many sections came back).',
      ),
  },

  enrichmentTrailer: {
    notice: { render: (value) => `> ${escapeMarkdownInline(String(value))}` },
  },

  async handler(input, ctx) {
    const office = input.office.toUpperCase();
    const result = await getNwsService().getOfficeDiscussion(office, input.product_type, ctx);
    const wanted = (input.sections ?? []).map((name) => name.trim()).filter(Boolean);

    ctx.log.info('Office discussion fetched', {
      office,
      productType: input.product_type,
      issuanceTime: result.issuanceTime,
      sections: wanted.length,
    });

    const full: DiscussionView = {
      issuanceTime: result.issuanceTime,
      issuingOffice: result.issuingOffice,
      productCode: result.productCode,
      productName: result.productName,
      productText: result.productText,
      wmoCollectiveId: result.wmoCollectiveId,
    };
    const responseBytes = Math.max(utf8Bytes(JSON.stringify(full)), utf8Bytes(renderText(full)));
    if (wanted.length === 0 && responseBytes <= BUDGET_BYTES) return full;

    const { header, parts, trailer } = partitionProduct(result.productText, input.product_type);
    const footer = trailer.trim();
    const { productText: _whole, ...metadata } = full;
    /** A selection's text: the header, the chosen parts, then the closing lines. */
    const assemble = (chosen: readonly ProductPart[]) =>
      [header, ...chosen.map((part) => part.text), footer].filter(Boolean).join('\n\n');

    if (wanted.length > 0) {
      const unmatched = wanted.filter((name) => !parts.some((part) => partMatches(part, name)));
      if (unmatched.length > 0) {
        const quoted = (names: readonly string[]) =>
          names.map((name) => JSON.stringify(name)).join(', ');
        const listed = parts
          .map((part) =>
            part.label ? `${quoted([part.name])} (${part.label})` : quoted([part.name]),
          )
          .join(', ');
        throw ctx.fail(
          'unknown_section',
          `No section of the latest ${office} ${input.product_type} matches ${quoted(unmatched)}. ${
            parts.length > 0
              ? `Available sections: ${listed}.`
              : 'This product has no sections to select; omit sections to get it whole.'
          }`,
          { unmatched, available: parts.map((part) => part.name) },
        );
      }
      const selected = parts.filter((part) => wanted.some((name) => partMatches(part, name)));
      ctx.enrich.notice(
        `Returned ${selected.length} of ${parts.length} sections with the product header: ${selected.map((part) => part.name).join('; ')}. Omit sections for the whole product.`,
      );
      return { ...metadata, productText: assemble(selected) };
    }

    // Over budget with nothing to choose between: the whole product, as before.
    if (parts.length < 2) return full;

    const rows = parts
      .map((part) => ({ part, bytes: utf8Bytes(part.text) }))
      .sort((a, b) => b.bytes - a.bytes);
    // What a selection adds to its sections' own bytes: header, closing lines, separators.
    const frameBytes = utf8Bytes(assemble([])) + 2;
    const example = rows.find((row) => frameBytes + row.bytes <= BUDGET_BYTES);
    const recall = example
      ? `Re-call with the same office and product_type plus sections:["${selectorFor(example.part)}"] to get that section (${example.bytes} bytes) with the product header. A selection returns the ${frameBytes}-byte product header and closing lines plus every section it names whole, so add up the listed sizes before naming several.`
      : `No single section fits the budget (the smallest is ${rows.at(-1)?.bytes} bytes); a sections:[...] selection still returns whole at any size.`;
    ctx.enrich.notice(
      `This ${input.product_type} is ${responseBytes} bytes, over the ${BUDGET_BYTES}-byte response budget, so its ${parts.length} sections are outlined instead of returned. ${recall}`,
    );
    return {
      ...metadata,
      outline: rows.map(({ part, bytes }) => ({
        name: part.name,
        ...(part.label ? { label: part.label } : {}),
        bytes,
      })),
    };
  },

  format: (result) => [{ type: 'text', text: renderText(result) }],
});
