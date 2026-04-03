/**
 * @fileoverview Tool: nws_search_alerts — searches active weather alerts across the US.
 * @module mcp-server/tools/definitions/search-alerts
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNwsService } from '@/services/nws/nws-service.js';

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
        'Filter to specific event types (e.g., ["Tornado Warning"]). Case-insensitive partial match. Use nws_list_alert_types to discover valid names.',
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
      .describe('Alert status filter. Almost always want "Actual".'),
  }),

  output: z.object({
    count: z.number().describe('Number of matching alerts'),
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
          affectedZones: z.array(z.string()).describe('Affected zone IDs'),
        }),
      )
      .describe('Matching alerts'),
  }),

  async handler(input, ctx) {
    const result = await getNwsService().searchAlerts(input, ctx);

    ctx.log.info('Alerts search completed', { count: result.alerts.length });

    return {
      count: result.alerts.length,
      alerts: result.alerts.map((a) => ({ ...a, affectedZones: [...a.affectedZones] })),
    };
  },

  format: (result) => {
    if (result.count === 0) {
      return [{ type: 'text', text: 'No active alerts found. All clear.' }];
    }

    const lines = [`## ${result.count} Active Alert${result.count > 1 ? 's' : ''}\n`];

    for (const a of result.alerts) {
      lines.push(`### ${a.event}`);
      if (a.headline) lines.push(`**${a.headline}**`);
      lines.push(
        `**Severity:** ${a.severity} | **Urgency:** ${a.urgency} | **Certainty:** ${a.certainty}`,
      );
      lines.push(`**Area:** ${a.areaDesc}`);
      if (a.onset) lines.push(`**Onset:** ${a.onset}`);
      if (a.expires) lines.push(`**Expires:** ${a.expires}`);
      lines.push(`**From:** ${a.senderName}`);
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

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
