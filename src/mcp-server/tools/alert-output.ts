/**
 * @fileoverview The per-alert output schema and markdown block shared by
 * nws_search_alerts and nws_get_alert, so one alert reads the same on both tools
 * and on both client surfaces.
 * @module mcp-server/tools/alert-output
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { Alert } from '@/services/nws/types.js';
import { formatTimestamp, zoneCodeToTimeZone } from './format-utils.js';

/** One NWS alert message: event, severity, area, hazard timing, and CAP lifecycle. */
export const alertOutputSchema = z
  .object({
    id: z
      .string()
      .describe(
        'Alert message ID. Pass it unchanged as alert_id to nws_get_alert to fetch this message again.',
      ),
    event: z.string().describe('Event type (e.g., "Tornado Warning")'),
    headline: z.string().nullable().describe('Alert headline'),
    description: z
      .string()
      .nullable()
      .describe('Full alert description; null when NWS publishes the alert without one'),
    instruction: z.string().nullable().describe('Recommended actions'),
    severity: z.string().describe('Severity level'),
    urgency: z.string().describe('Urgency level'),
    certainty: z.string().describe('Certainty level'),
    areaDesc: z.string().describe('Affected area description'),
    sent: z
      .string()
      .describe(
        'Message issuance time (ISO 8601) — when the office transmitted this CAP message. Describes the message, not the hazard: use it to judge how stale the report is.',
      ),
    effective: z
      .string()
      .describe(
        'Message effective time (ISO 8601) — when this version of the CAP message takes effect. A property of the message, not of the hazard: distinct from onset (when the hazard begins) and from expires (when a superseding message is due). Usually equals sent.',
      ),
    onset: z
      .string()
      .nullable()
      .describe('Expected hazard onset (ISO 8601). When the hazard is expected to begin.'),
    ends: z
      .string()
      .nullable()
      .describe(
        'Hazard end (ISO 8601) — when the hazard is expected to end; null when open-ended ("until further notice"). Distinct from expires, which is the message-refresh time.',
      ),
    expires: z
      .string()
      .nullable()
      .describe(
        'Message expiration (ISO 8601) — when NWS will issue a superseding statement. NOT when the hazard ends; the hazard window is described in the headline.',
      ),
    status: z
      .string()
      .describe(
        'This alert\'s own CAP status as reported by NWS ("Actual", "Exercise", "System", "Test", "Draft"). Distinct from the nws_search_alerts status input filter, which selects which alerts a search covers — with that filter at its default, every alert a search returns reads "Actual".',
      ),
    messageType: z
      .string()
      .describe(
        'CAP message type: "Alert" for an original issuance, "Update" for a revision of an earlier message, "Cancel" for a cancellation.',
      ),
    references: z
      .array(
        z
          .object({
            identifier: z
              .string()
              .describe(
                'CAP identifier of the superseded message. Pass it unchanged as alert_id to nws_get_alert to read that message, which carries its own references.',
              ),
            sent: z.string().describe('When the superseded message was issued (ISO 8601)'),
          })
          .describe('One prior message this alert supersedes'),
      )
      .describe(
        'Prior alert messages this one supersedes, newest first by sent instant; messages sent at the same instant keep the order NWS lists them in, and one whose sent time does not parse comes last. Empty for an original issuance — never inferred when NWS reports none. nws_get_alert fetches any of them by identifier. Every reference sharing the newest sent time is an immediate predecessor (an update can merge several earlier segments); the first is one of them.',
      ),
    senderName: z.string().describe('Issuing office'),
    affectedZones: z
      .array(
        z
          .object({
            code: z.string().describe('Zone code, e.g. "WAZ558" (forecast) or "WAC033" (county)'),
            type: z
              .string()
              .describe(
                'NWS zone type: "forecast", "county", or "fire" ("unknown" when upstream reports a shape this server cannot type). Only "forecast" codes have a zone text forecast — pass those to nws_get_zone_forecast. All types are valid values for the nws_search_alerts zone filter.',
              ),
          })
          .describe('Affected zone with its NWS zone type'),
      )
      .describe('Affected zones, each with the zone type that decides where it can chain'),
  })
  .describe('Single alert message with event, severity, area, and timing');

/** The per-alert object both alert tools return. */
export type AlertOutput = z.infer<typeof alertOutputSchema>;

/** A service alert as the output object: the service's readonly arrays copied to mutable ones. */
export function toAlertOutput(alert: Alert): AlertOutput {
  return {
    ...alert,
    affectedZones: [...alert.affectedZones],
    references: [...alert.references],
  };
}

/**
 * Markdown lines for one alert, from its event heading through its recommended
 * actions. Times render in a named US zone derived from the first affected zone
 * code (PDT/CDT/EDT), like forecasts and observations, falling back to a numeric
 * UTC offset when no zone resolves.
 */
export function alertMarkdownLines(alert: AlertOutput): string[] {
  const timeZone = zoneCodeToTimeZone(alert.affectedZones[0]?.code);
  const lines = [`### ${alert.event}`, `_ID: ${alert.id}_`];

  if (alert.headline) lines.push(`**${alert.headline}**`);
  lines.push(
    `**Severity:** ${alert.severity} | **Urgency:** ${alert.urgency} | **Certainty:** ${alert.certainty}`,
  );
  lines.push(`**Area:** ${alert.areaDesc}`);
  if (alert.onset) lines.push(`**Hazard onset:** ${formatTimestamp(alert.onset, timeZone)}`);
  if (alert.ends) lines.push(`**Hazard ends:** ${formatTimestamp(alert.ends, timeZone)}`);
  if (alert.expires) {
    lines.push(`**Message valid until:** ${formatTimestamp(alert.expires, timeZone)}`);
  }
  lines.push(`**Message type:** ${alert.messageType} | **Status:** ${alert.status}`);
  lines.push(
    `**Message sent:** ${formatTimestamp(alert.sent, timeZone)} | **Message effective:** ${formatTimestamp(alert.effective, timeZone)}`,
  );
  if (alert.references.length > 0) {
    const priors = alert.references
      .map((r) => `${r.identifier} (sent ${formatTimestamp(r.sent, timeZone)})`)
      .join('; ');
    lines.push(`**Supersedes:** ${priors}`);
  }
  lines.push(`**From:** ${alert.senderName}`);
  if (alert.affectedZones.length > 0) {
    lines.push(`**Zones:** ${alert.affectedZones.map((z) => `${z.code} (${z.type})`).join(', ')}`);
  }
  if (alert.description) lines.push('', alert.description);
  if (alert.instruction) lines.push('', `**Recommended Actions:** ${alert.instruction}`);
  return lines;
}
