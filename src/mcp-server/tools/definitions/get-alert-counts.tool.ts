/**
 * @fileoverview Tool: nws_get_alert_counts — national active-alert counts per area and marine region.
 * @module mcp-server/tools/definitions/get-alert-counts
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNwsService } from '@/services/nws/nws-service.js';

/** Display names for the NWS MarineRegionCode enumeration, matching nws_search_alerts. */
const MARINE_REGION_NAMES: ReadonlyMap<string, string> = new Map([
  ['AL', 'Alaska waters'],
  ['AT', 'Atlantic Ocean'],
  ['GL', 'Great Lakes'],
  ['GM', 'Gulf of Mexico'],
  ['PA', 'Eastern Pacific and US West Coast'],
  ['PI', 'Central and Western Pacific'],
]);

/** Count-map entries, highest count first, ties by code, so the order is stable. */
function byCountDescending(counts: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

export const getAlertCountsTool = tool('nws_get_alert_counts', {
  description:
    'Count active weather alerts nationwide, per state/territory or marine area, and per marine region, in one small response — the answer to "how many alerts are active, and where" without fetching the alerts themselves. Counts cover every message status, Test and Exercise included, so totalAlerts can run above the totalCount a national nws_search_alerts search reports under its default status of Actual. An alert counts once in each area its zones fall in, so the area counts can sum past totalAlerts; landAlerts plus marineAlerts equals totalAlerts. Takes no filters. For counts per zone or under a filter, call nws_search_alerts with that zone or filter and read its totalCount.',
  annotations: { readOnlyHint: true },

  input: z.object({}),

  output: z.object({
    totalAlerts: z
      .number()
      .describe(
        'Active alerts nationwide across every message status (Actual, Exercise, System, Test, Draft). Can exceed the totalCount of a national nws_search_alerts search, which counts status Actual by default.',
      ),
    landAlerts: z.number().describe('Active alerts affecting land zones.'),
    marineAlerts: z
      .number()
      .describe('Active alerts affecting marine zones. landAlerts + marineAlerts = totalAlerts.'),
    areas: z
      .record(z.string(), z.number())
      .describe(
        'Active alert counts keyed by state/territory code (e.g., "WA", "PR") or marine area code (e.g., "PZ", "GM"). Only areas with an active alert appear. An alert counts once in each area its zones fall in, so these can sum past totalAlerts. Area "AL" is Alabama; Alaska waters are region "AL" in regions.',
      ),
    regions: z
      .record(z.string(), z.number())
      .describe(
        'Active marine alert counts keyed by marine region: "AL" (Alaska waters), "AT" (Atlantic Ocean), "GL" (Great Lakes), "GM" (Gulf of Mexico), "PA" (Eastern Pacific and US West Coast), "PI" (Central and Western Pacific). Only regions with an active alert appear, so the map is empty when no marine alert is active.',
      ),
  }),

  async handler(_input, ctx) {
    const counts = await getNwsService().getAlertCounts(ctx);
    return {
      totalAlerts: counts.total,
      landAlerts: counts.land,
      marineAlerts: counts.marine,
      areas: counts.areas,
      regions: counts.regions,
    };
  },

  format: (result) => {
    const areas = byCountDescending(result.areas);
    const regions = byCountDescending(result.regions);
    const lines = [
      `## Active NWS Alerts: ${result.totalAlerts}`,
      `**Land:** ${result.landAlerts} | **Marine:** ${result.marineAlerts}`,
      '',
      '_Counts include every message status (Test and Exercise too). An alert counts once in each area its zones fall in._',
      '',
      `### By Area (${areas.length})`,
    ];

    if (areas.length === 0) {
      lines.push('_No area has an active alert._');
    } else {
      lines.push('| Area | Alerts |', '|:-----|-------:|');
      for (const [code, count] of areas) lines.push(`| ${code} | ${count} |`);
    }

    lines.push('', `### By Marine Region (${regions.length})`);
    if (regions.length === 0) {
      lines.push('_No marine region has an active alert._');
    } else {
      lines.push('| Region | Alerts |', '|:-------|-------:|');
      for (const [code, count] of regions) {
        const name = MARINE_REGION_NAMES.get(code);
        lines.push(`| ${name ? `${name} (${code})` : code} | ${count} |`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
