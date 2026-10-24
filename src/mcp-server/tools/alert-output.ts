/**
 * @fileoverview The per-alert output schema and markdown block shared by
 * nws_search_alerts and nws_get_alert, so one alert reads the same on both tools
 * and on both client surfaces.
 * @module mcp-server/tools/alert-output
 */

import { z } from '@cyanheads/mcp-ts-core';
import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';
import type { ALERT_HAZARD_KEYS, Alert } from '@/services/nws/types.js';
import { formatTimestamp, zoneCodeToTimeZone } from './format-utils.js';

/** One schema per NWS hazard tag, keyed by the NWS key name. */
const hazardTagSchemas = {
  maxHailSize: z
    .string()
    .optional()
    .describe('Maximum hail size in inches, as NWS states it (e.g., "1.00", "Up to .75")'),
  maxWindGust: z
    .string()
    .optional()
    .describe('Maximum wind gust, as NWS states it (e.g., "60 MPH", "34 knots")'),
  hailThreat: z
    .string()
    .optional()
    .describe('How the hail is known (e.g., "RADAR INDICATED", "OBSERVED")'),
  windThreat: z
    .string()
    .optional()
    .describe('How the wind is known (e.g., "RADAR INDICATED", "OBSERVED")'),
  tornadoDetection: z
    .string()
    .optional()
    .describe('Tornado detection (e.g., "RADAR INDICATED", "POSSIBLE")'),
  tornadoDamageThreat: z.string().optional().describe('Tornado damage-threat tag'),
  thunderstormDamageThreat: z
    .string()
    .optional()
    .describe('Thunderstorm damage-threat tag (e.g., "CONSIDERABLE")'),
  flashFloodDetection: z
    .string()
    .optional()
    .describe(
      'Flash flood detection (e.g., "RADAR INDICATED", "OBSERVED", "RADAR AND GAUGE INDICATED")',
    ),
  flashFloodDamageThreat: z
    .string()
    .optional()
    .describe('Flash flood damage-threat tag (e.g., "CONSIDERABLE")'),
  waterspoutDetection: z.string().optional().describe('Waterspout detection (e.g., "POSSIBLE")'),
  eventMotionDescription: z
    .string()
    .optional()
    .describe(
      'Storm time, motion, and position in NWS encoding (e.g., "2026-10-22T17:17:00-00:00...storm...222DEG...11KT...34.0,-118.1")',
    ),
} satisfies Record<(typeof ALERT_HAZARD_KEYS)[number], z.ZodOptional<z.ZodString>>;

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
    senderName: z
      .string()
      .describe(
        'Issuing office name (e.g., "NWS Riverton WY"); the office code nws_get_office_discussion takes is in office',
      ),
    office: z
      .string()
      .nullable()
      .describe(
        'Issuing forecast office code (e.g., "RIW"), from the issuing centre in the message\'s WMO header; pass it as office to nws_get_office_discussion. Null for tsunami warning centres and national test messages, which have no office discussion, and when NWS sends no usable WMO header.',
      ),
    vtec: z
      .array(z.string().describe('One P-VTEC string, verbatim'))
      .describe(
        'Raw P-VTEC strings NWS attaches (e.g., "/O.CON.KRIW.FW.W.0031.261023T1800Z-261024T0200Z/"), the key that tracks one event across its updates; empty when NWS sends none (e.g., Special Weather Statements).',
      ),
    nwsHeadline: z
      .string()
      .nullable()
      .describe(
        'The NWS product headline (e.g., "RED FLAG WARNING IN EFFECT FROM NOON TO 8 PM MDT FRIDAY"), distinct from headline; null when NWS sends none.',
      ),
    hazard: z
      .object(hazardTagSchemas)
      .nullable()
      .describe(
        'Severe-weather tags NWS attaches, under NWS key names with values verbatim (free text such as "Up to .75" or "34 knots"). Only the tags NWS sent are present; null when it sent none.',
      ),
    affectedZones: z
      .array(
        z
          .object({
            code: z.string().describe('Zone code, e.g. "WAZ558" (forecast) or "WAC033" (county)'),
            type: z
              .string()
              .describe(
                'NWS zone type: "forecast", "county", or "fire" ("unknown" when upstream reports a shape this server cannot type). A "forecast" code has a zone text forecast: pass it to nws_get_zone_forecast. A "fire" code has a segment in its office\'s Fire Weather Planning Forecast: call nws_get_office_discussion with office from this alert\'s office field, product_type "FWF", and sections [code]. All types are valid values for the nws_search_alerts zone filter.',
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
    vtec: [...alert.vtec],
    hazard: alert.hazard && { ...alert.hazard },
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
  const lines = [
    `### ${escapeMarkdownInline(alert.event)}`,
    `_ID: ${escapeMarkdownInline(alert.id)}_`,
  ];

  if (alert.headline) lines.push(`**${escapeMarkdownInline(alert.headline)}**`);
  if (alert.nwsHeadline) lines.push(`**NWS headline:** ${escapeMarkdownInline(alert.nwsHeadline)}`);
  lines.push(
    `**Severity:** ${escapeMarkdownInline(alert.severity)} | **Urgency:** ${escapeMarkdownInline(alert.urgency)} | **Certainty:** ${escapeMarkdownInline(alert.certainty)}`,
  );
  lines.push(`**Area:** ${escapeMarkdownInline(alert.areaDesc)}`);
  if (alert.onset) lines.push(`**Hazard onset:** ${formatTimestamp(alert.onset, timeZone)}`);
  if (alert.ends) lines.push(`**Hazard ends:** ${formatTimestamp(alert.ends, timeZone)}`);
  if (alert.expires) {
    lines.push(`**Message valid until:** ${formatTimestamp(alert.expires, timeZone)}`);
  }
  lines.push(
    `**Message type:** ${escapeMarkdownInline(alert.messageType)} | **Status:** ${escapeMarkdownInline(alert.status)}`,
  );
  lines.push(
    `**Message sent:** ${formatTimestamp(alert.sent, timeZone)} | **Message effective:** ${formatTimestamp(alert.effective, timeZone)}`,
  );
  if (alert.references.length > 0) {
    const priors = alert.references
      .map(
        (r) =>
          `${escapeMarkdownInline(r.identifier)} (sent ${escapeMarkdownInline(formatTimestamp(r.sent, timeZone))})`,
      )
      .join('; ');
    lines.push(`**Supersedes:** ${priors}`);
  }
  lines.push(`**From:** ${escapeMarkdownInline(alert.senderName)}`);
  if (alert.office) lines.push(`**Office:** ${escapeMarkdownInline(alert.office)}`);
  if (alert.affectedZones.length > 0) {
    lines.push(
      `**Zones:** ${alert.affectedZones.map((z) => `${escapeMarkdownInline(z.code)} (${escapeMarkdownInline(z.type)})`).join(', ')}`,
    );
  }
  if (alert.vtec.length > 0)
    lines.push(`**VTEC:** ${alert.vtec.map(escapeMarkdownInline).join(', ')}`);
  if (alert.hazard) {
    const tags = Object.entries(alert.hazard).map(
      ([key, value]) => `${key}: ${escapeMarkdownInline(String(value))}`,
    );
    lines.push(`**Hazard tags:** ${tags.join('; ')}`);
  }
  // NWS hard-wraps both texts, with `* WHAT...` bullets and Markdown
  // metacharacters, so each goes in a fenced block a CommonMark parse reads back
  // verbatim; the fence outgrows any backtick run in the text.
  if (alert.description) lines.push('', fencedText(alert.description));
  if (alert.instruction) {
    lines.push('', '**Recommended Actions:**', fencedText(alert.instruction));
  }
  return lines;
}

/** NWS text as one fenced `text` code block. */
function fencedText(value: string): string {
  return markdown().codeBlock(value, 'text').build();
}
