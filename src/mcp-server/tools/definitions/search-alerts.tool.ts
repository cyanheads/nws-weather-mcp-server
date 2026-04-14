/**
 * @fileoverview Tool: nws_search_alerts — searches active weather alerts across the US.
 * @module mcp-server/tools/definitions/search-alerts
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNwsService } from '@/services/nws/nws-service.js';
import { formatTimestamp } from '../format-utils.js';

const MAX_ALERTS = 25;

/** Valid area codes: US states, DC, territories, and marine areas. */
const VALID_AREA_CODES = new Set([
  // States + DC
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  // Territories & freely associated states
  'AS',
  'FM',
  'GU',
  'MH',
  'MP',
  'PR',
  'PW',
  'VI',
  // Marine areas
  'AM',
  'AN',
  'GM',
  'LC',
  'LE',
  'LH',
  'LM',
  'LO',
  'LS',
  'PH',
  'PK',
  'PM',
  'PS',
  'PZ',
  'SL',
]);

/** Build a human-readable summary of the applied search filters. */
function describeFilters(input: Record<string, unknown>): string {
  const parts: string[] = [];
  if (input.area) parts.push(`area=${input.area}`);
  if (input.point) parts.push(`point=${input.point}`);
  if (input.zone) parts.push(`zone=${input.zone}`);
  if (Array.isArray(input.event) && input.event.length)
    parts.push(`event=${input.event.join(', ')}`);
  if (Array.isArray(input.severity) && input.severity.length)
    parts.push(`severity=${input.severity.join(', ')}`);
  if (Array.isArray(input.urgency) && input.urgency.length)
    parts.push(`urgency=${input.urgency.join(', ')}`);
  if (Array.isArray(input.certainty) && input.certainty.length)
    parts.push(`certainty=${input.certainty.join(', ')}`);
  if (input.status && input.status !== 'Actual') parts.push(`status=${input.status}`);
  return parts.length > 0 ? parts.join(', ') : 'national (no filters)';
}

export const searchAlertsTool = tool('nws_search_alerts', {
  description:
    'Search active weather alerts (watches, warnings, advisories) across the US. Filter by state, coordinates, zone, event type, severity, urgency, or certainty. Omit all filters for a national search.',
  annotations: { readOnlyHint: true },

  input: z.object({
    area: z
      .string()
      .optional()
      .describe(
        'US state/territory code (e.g., "WA", "OK", "PR") or marine area code (e.g., "GM").',
      ),
    point: z
      .string()
      .optional()
      .describe(
        'Coordinates as "lat,lon" (e.g., "47.6,-122.3"). Returns alerts whose geometry contains this point.',
      ),
    zone: z
      .string()
      .optional()
      .describe('NWS forecast zone (e.g., "WAZ558") or county zone (e.g., "WAC033").'),
    event: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to specific event types (e.g., ["Tornado Warning"]). Matches are case-insensitive and partial, so "tornado" matches both "Tornado Warning" and "Tornado Watch". Use nws_list_alert_types to discover valid names.',
      ),
    severity: z
      .array(z.enum(['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown']))
      .optional()
      .describe('Filter by severity level.'),
    urgency: z
      .array(z.enum(['Immediate', 'Expected', 'Future', 'Past']))
      .optional()
      .describe('Filter by urgency level.'),
    certainty: z
      .array(z.enum(['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown']))
      .optional()
      .describe('Filter by certainty level.'),
    status: z
      .enum(['Actual', 'Exercise', 'System', 'Test', 'Draft'])
      .default('Actual')
      .describe(
        'Alert status filter. Default "Actual". Use a different value only when you specifically need non-live alerts.',
      ),
  }),

  output: z.object({
    count: z.number().describe('Total number of matching alerts'),
    shown: z.number().describe('Number of alerts included in this response'),
    filters: z.string().describe('Summary of applied search filters'),
    alerts: z
      .array(
        z.object({
          id: z.string().describe('Alert ID'),
          event: z.string().describe('Event type (e.g., "Tornado Warning")'),
          headline: z.string().nullable().describe('Alert headline'),
          description: z.string().describe('Full alert description'),
          instruction: z.string().nullable().describe('Recommended actions'),
          severity: z.string().describe('Severity level'),
          urgency: z.string().describe('Urgency level'),
          certainty: z.string().describe('Certainty level'),
          areaDesc: z.string().describe('Affected area description'),
          onset: z.string().nullable().describe('Expected onset (ISO 8601)'),
          expires: z.string().nullable().describe('Expiration time (ISO 8601)'),
          senderName: z.string().describe('Issuing office'),
          affectedZones: z.array(z.string()).describe('Affected zone codes'),
        }),
      )
      .describe('Matching alerts (capped at 25)'),
  }),

  async handler(input, ctx) {
    // Normalize and validate area code — the NWS API is case-sensitive (lowercase → 400)
    if (input.area) {
      input.area = input.area.toUpperCase();
      if (!VALID_AREA_CODES.has(input.area)) {
        throw new Error(
          `Invalid area code "${input.area}". Use a 2-letter US state/territory code (e.g., "WA", "OK", "PR") or marine area code (e.g., "GM").`,
        );
      }
    }

    // Validate point format before hitting the API
    if (input.point) {
      const [lat, lon, ...rest] = input.point.split(',').map(Number);
      if (
        rest.length > 0 ||
        lat == null ||
        lon == null ||
        Number.isNaN(lat) ||
        Number.isNaN(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      ) {
        throw new Error(
          `Invalid point "${input.point}". Provide "lat,lon" with latitude -90 to 90 and longitude -180 to 180 (e.g., "47.6,-122.3").`,
        );
      }
    }

    const result = await getNwsService().searchAlerts(input, ctx);
    const total = result.alerts.length;
    const capped = result.alerts.slice(0, MAX_ALERTS);
    const filters = describeFilters(input);

    ctx.log.info('Alerts search completed', { total, shown: capped.length, filters });

    return {
      count: total,
      shown: capped.length,
      filters,
      alerts: capped.map((a) => ({ ...a, affectedZones: [...a.affectedZones] })),
    };
  },

  format: (result) => {
    if (result.count === 0) {
      const lines = [
        `No active alerts found for: ${result.filters}.`,
        '',
        'To broaden your search, try:',
        '- Use **area** (e.g., "WA") for state-wide alerts',
        '- Remove severity/event filters',
        '- Use nws_list_alert_types to verify event names',
      ];
      return [{ type: 'text', text: lines.join('\n') }];
    }

    const truncated = result.shown < result.count;
    const heading = truncated
      ? `## Showing ${result.shown} of ${result.count} Active Alerts`
      : `## ${result.count} Active Alert${result.count > 1 ? 's' : ''}`;

    const lines = [`${heading}\n**Filters:** ${result.filters}\n`];

    for (const a of result.alerts) {
      lines.push(`### ${a.event}`);
      lines.push(`_ID: ${a.id}_`);
      if (a.headline) lines.push(`**${a.headline}**`);
      lines.push(
        `**Severity:** ${a.severity} | **Urgency:** ${a.urgency} | **Certainty:** ${a.certainty}`,
      );
      lines.push(`**Area:** ${a.areaDesc}`);
      if (a.onset) lines.push(`**Onset:** ${formatTimestamp(a.onset)}`);
      if (a.expires) lines.push(`**Expires:** ${formatTimestamp(a.expires)}`);
      lines.push(`**From:** ${a.senderName}`);
      if (a.affectedZones.length > 0) {
        lines.push(`**Zones:** ${a.affectedZones.join(', ')}`);
      }
      lines.push('');
      lines.push(a.description);
      if (a.instruction) {
        lines.push('');
        lines.push(`**Recommended Actions:** ${a.instruction}`);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    if (truncated) {
      lines.push(
        `_${result.count - result.shown} more alerts not shown. Narrow with area, severity, or event filters to see specific alerts._`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
