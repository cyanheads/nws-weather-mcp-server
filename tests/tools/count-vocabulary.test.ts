/**
 * @fileoverview Cross-tool contract for the paged tools' count vocabulary (issue #35):
 * `totalCount` is the pre-limit match count and `shown` is this response's count,
 * on every tool that pages. Per-tool tests pin the values; this pins that the three
 * windowing tools declare the same two names, that the retired ones are gone, and
 * how the upstream-paged and unpaged tools fit the same vocabulary.
 * @module tests/tools/count-vocabulary
 */

import { describe, expect, it } from 'vitest';
import { findStationsTool } from '@/mcp-server/tools/definitions/find-stations.tool.js';
import { getAlertCountsTool } from '@/mcp-server/tools/definitions/get-alert-counts.tool.js';
import { getForecastTool } from '@/mcp-server/tools/definitions/get-forecast.tool.js';
import { getObservationHistoryTool } from '@/mcp-server/tools/definitions/get-observation-history.tool.js';
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

/**
 * nws_get_observation_history pages upstream (issue #26): NWS reports no total for
 * an observation window, so the tool reports `shown` alone. A `totalCount` there
 * could only be this page's count under the pre-limit name — the exact confusion
 * the shared vocabulary exists to prevent.
 */
describe('upstream-paged tools report shown without totalCount (issue #26)', () => {
  it('nws_get_observation_history declares a labeled shown and no totalCount', () => {
    const keys = Object.keys(getObservationHistoryTool.enrichment ?? {});
    const trailer = getObservationHistoryTool.enrichmentTrailer as
      | Record<string, { label?: string }>
      | undefined;

    expect(keys).toContain('shown');
    expect(keys).not.toContain('totalCount');
    expect(trailer?.shown?.label).toEqual(expect.any(String));
  });

  it('nws_get_observation_history declares none of the retired count fields', () => {
    const keys = new Set([
      ...Object.keys(getObservationHistoryTool.enrichment ?? {}),
      ...Object.keys(getObservationHistoryTool.output.shape),
    ]);
    for (const retired of RETIRED_FIELDS) {
      expect(keys).not.toContain(retired);
    }
  });
});

/**
 * nws_get_alert_counts pages nothing (issue #25). Its national total is a count of
 * active alerts named for what it counts, so neither paging name appears on it.
 */
describe('unpaged count tools use neither paging count name (issue #25)', () => {
  it('nws_get_alert_counts declares no totalCount, shown, or retired count field', () => {
    const keys = new Set([
      ...Object.keys(getAlertCountsTool.enrichment ?? {}),
      ...Object.keys(getAlertCountsTool.output.shape),
    ]);
    for (const name of ['totalCount', 'shown', ...RETIRED_FIELDS]) {
      expect(keys).not.toContain(name);
    }
    expect(keys).toContain('totalAlerts');
  });
});
