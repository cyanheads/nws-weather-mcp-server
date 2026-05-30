/**
 * @fileoverview Tool: nws_get_office_discussion — fetches the latest narrative product from a Weather Forecast Office.
 * @module mcp-server/tools/definitions/get-office-discussion
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNwsService } from '@/services/nws/nws-service.js';

export const getOfficeDiscussionTool = tool('nws_get_office_discussion', {
  description:
    'Get the latest narrative forecast product from a Weather Forecast Office (WFO). The default product is AFD (Area Forecast Discussion), which explains the meteorological reasoning behind the forecast — synoptic setup, model guidance, and forecaster confidence. Other types: HWO (Hazardous Weather Outlook, 1-7 day severe/flood/winter outlook), ZFP (Zone Forecast Product, zone-by-zone text), SPS (Special Weather Statement, short-fuse advisory). The office code is the 3-letter WFO identifier returned as the "office" field by nws_get_forecast. Fetches the two-hop products API: list endpoint first (newest product), then the full product detail.',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'no_products',
      code: JsonRpcErrorCode.NotFound,
      when: 'Office code is unknown or has no products of the requested type',
      recovery:
        'Use nws_get_forecast with coordinates to find the WFO code in the "office" field of the location object, then retry.',
    },
  ],

  input: z.object({
    office: z
      .string()
      .min(1)
      .describe(
        'Three-letter Weather Forecast Office (WFO) code (e.g., "SEW" for Seattle, "LOX" for Los Angeles). Returned as the "office" field in nws_get_forecast output.',
      ),
    product_type: z
      .enum(['AFD', 'HWO', 'ZFP', 'SPS'])
      .default('AFD')
      .describe(
        'Product type code. AFD (Area Forecast Discussion) — meteorological reasoning, model analysis, forecaster confidence. HWO (Hazardous Weather Outlook) — 1-7 day outlook for severe weather, flooding, winter weather. ZFP (Zone Forecast Product) — detailed zone-by-zone text forecast. SPS (Special Weather Statement) — short-fuse advisory for notable non-warning weather.',
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
      .describe(
        'Full narrative product text as issued by the forecaster. AFDs are typically 1,000-3,000 words covering synoptic setup, model guidance, and period-by-period reasoning.',
      ),
    wmoCollectiveId: z
      .string()
      .describe(
        'WMO collective identifier (e.g., "FXUS66"). Identifies the product family in international message routing.',
      ),
  }),

  async handler(input, ctx) {
    const office = input.office.trim().toUpperCase();
    const result = await getNwsService().getOfficeDiscussion(office, input.product_type, ctx);

    ctx.log.info('Office discussion fetched', {
      office,
      productType: input.product_type,
      issuanceTime: result.issuanceTime,
    });

    return {
      issuanceTime: result.issuanceTime,
      issuingOffice: result.issuingOffice,
      productCode: result.productCode,
      productName: result.productName,
      productText: result.productText,
      wmoCollectiveId: result.wmoCollectiveId,
    };
  },

  format: (result) => {
    const lines = [
      `## ${result.productName} (${result.productCode})`,
      `**Office:** ${result.issuingOffice} | **Issued:** ${result.issuanceTime} | **WMO ID:** ${result.wmoCollectiveId}`,
      '',
      result.productText,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
