/**
 * @fileoverview Cross-tool contract for the paged tools' count vocabulary (issue #35):
 * `totalCount` is the pre-limit match count and `shown` is this response's count,
 * on every tool that pages. Per-tool tests pin the values; this pins that the three
 * declare the same two names and that the retired ones are gone.
 * @module tests/tools/count-vocabulary
 */

import { describe, expect, it } from 'vitest';
import { findStationsTool } from '@/mcp-server/tools/definitions/find-stations.tool.js';
import { getForecastTool } from '@/mcp-server/tools/definitions/get-forecast.tool.js';
import { searchAlertsTool } from '@/mcp-server/tools/definitions/search-alerts.tool.js';

/** Every tool that windows a fetched collection and reports both counts. */
const PAGED_TOOLS = [
  ['nws_get_forecast', getForecastTool],
  ['nws_find_stations', findStationsTool],
  ['nws_search_alerts', searchAlertsTool],
] as const;

/**
 * Names each tool used before the vocabulary was unified. A caller that reaches
 * for one must get `undefined` — a loud miss — rather than a silently different
 * number, which is the failure #35 describes.
 */
const RETIRED_FIELDS = ['totalFound', 'shownCount', 'periodCount', 'totalPeriodCount'] as const;

describe('paged tools share one count vocabulary (issue #35)', () => {
  it.each(PAGED_TOOLS)(
    '%s declares totalCount and shown in its enrichment block',
    (_name, tool) => {
      const keys = Object.keys(tool.enrichment ?? {});
      expect(keys).toContain('totalCount');
      expect(keys).toContain('shown');
    },
  );

  it.each(PAGED_TOOLS)('%s declares none of the retired count fields', (_name, tool) => {
    const keys = new Set([
      ...Object.keys(tool.enrichment ?? {}),
      ...Object.keys(tool.output.shape),
    ]);
    for (const retired of RETIRED_FIELDS) {
      expect(keys).not.toContain(retired);
    }
  });

  it.each(PAGED_TOOLS)('%s labels both counts in its content[] trailer', (_name, tool) => {
    // The machine field is uniform; the human-readable label stays tool-specific
    // ("Total Nearby", "Total Periods"), so both must still carry one.
    const trailer = tool.enrichmentTrailer as Record<string, { label?: string }> | undefined;
    expect(trailer?.totalCount?.label).toEqual(expect.any(String));
    expect(trailer?.shown?.label).toEqual(expect.any(String));
  });

  it('describes totalCount as the pre-limit total on every tool, never this page', () => {
    for (const [, tool] of PAGED_TOOLS) {
      const description = tool.enrichment?.totalCount?.description ?? '';
      expect(description).toMatch(/before .*(limit|page|window)/i);
    }
  });
});
