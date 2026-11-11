/**
 * @fileoverview Tool: nws_get_zone_forecast — fetches the text forecast for an NWS forecast zone,
 * correcting the 12-hour misread NWS makes in its `updated` time.
 * @module mcp-server/tools/definitions/get-zone-forecast
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getNwsService } from '@/services/nws/nws-service.js';

/**
 * Forecast-zone shape advertised as a JSON Schema `pattern` (issue #54): a 2-letter
 * prefix, a `Z` infix, and 3 digits, in any case and with surrounding whitespace,
 * which the schema trims. County (`C`) codes have no zone forecast. A malformed or
 * unknown code still fails in the service as zone_not_found.
 */
export const ZONE_ID_INPUT_PATTERN = /^\s*[A-Za-z]{2}[Zz]\d{3}\s*$/;

/** An ISO 8601 time split into date, hour, the rest of the clock time, and UTC offset. */
const UPDATED_FIELDS =
  /^(\d{4}-\d{2}-\d{2})T(\d{2})(:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})$/;

const TWELVE_HOURS_MS = 12 * 3_600_000;

/**
 * `updated` as the instant of the issuance line it comes from, with the notice owed.
 * NWS takes `updated` from the header issuance line of the forecast's source product
 * and reads its `12xx AM` hour as noon, so a midnight-hour forecast reports a time 12
 * hours late; a misread lands at hour 12 or 00 in NWS's own offset. A future value at
 * either hour moves back 12 hours. A past hour-00 value moves forward 12 hours when
 * that is not after now: while NWS reads `12xx AM` as noon, no faithful reading lands
 * at 00. A moved value keeps NWS's offset. Any other future value stays, flagged as
 * untrustworthy; a value that does not parse passes through.
 */
function readUpdated(sent: string, now: number): { notice?: string; updated: string } {
  const at = Date.parse(sent);
  if (Number.isNaN(at)) return { updated: sent };
  const fields = UPDATED_FIELDS.exec(sent);
  const hour = fields?.[2];

  if (at > now) {
    if (fields && (hour === '12' || hour === '00')) return moveTwelveHours(sent, fields, 'back');
    return {
      updated: sent,
      notice: `NWS sent updated as ${sent}, later than this response, so it cannot be trusted as the forecast's update time; it is returned as sent.`,
    };
  }
  if (fields && hour === '00' && at + TWELVE_HOURS_MS <= now) {
    return moveTwelveHours(sent, fields, 'forward');
  }
  return { updated: sent };
}

/** `sent` 12 hours earlier or later, in its own UTC offset, with the notice naming `sent`. */
function moveTwelveHours(
  sent: string,
  [, date, hour, rest, offset]: RegExpExecArray,
  direction: 'back' | 'forward',
): { notice: string; updated: string } {
  // Wall-clock arithmetic in NWS's offset: 12 hours there is 12 hours anywhere.
  const wall =
    Date.parse(`${date}T${hour}:00:00Z`) + (direction === 'back' ? -1 : 1) * TWELVE_HOURS_MS;
  const updated = `${new Date(wall).toISOString().slice(0, 13)}${rest}${offset}`;
  return {
    updated,
    notice: `NWS sent updated as ${sent}, 12 hours off: NWS misreads the 12 o'clock hour of the issuance time it takes updated from. Moved ${direction} 12 hours to ${updated}.`,
  };
}

export const getZoneForecastTool = tool('nws_get_zone_forecast', {
  description:
    'Get the text forecast for an NWS forecast zone. Returns named forecast periods (e.g., "Today", "Tonight", "Monday") with detailed narrative text — the human-readable, zone-level forecast written by local forecasters. Completes the alert-to-forecast chain: nws_search_alerts returns each affected zone in "affectedZones" as a code plus a type, and nws_find_stations returns codes in the "forecastZone" column. Only affectedZones entries with type "forecast" work here; entries typed "county" have no text forecast upstream and will not resolve. An entry typed "fire" has its forecast in a segment of the office\'s Fire Weather Planning Forecast: call nws_get_office_discussion with office set to the alert\'s "office" field, product_type "FWF", and sections set to the zone code; a fire zone code that is also a public zone code (e.g., "NDZ040") returns that public zone\'s forecast here, not the fire weather forecast. Marine zones vary by family: coastal zones on an ocean coast, bay, or sound (codes starting AMZ, ANZ, GMZ, PHZ, or PZZ, e.g., "PZZ251") usually serve a text forecast of wind and seas, while Great Lakes, most Alaska, Guam, American Samoa, and offshore zones (e.g., "GMZ056") have none. Zone codes follow the pattern XXZ### (e.g., "WAZ315" for the City of Seattle).',
  annotations: { readOnlyHint: true },
  // Every reason below is raised by the NWS service layer carrying only the
  // reason, not by a `ctx.fail` in this handler; the framework fills the hint.
  // An unknown or marine zone is a modeled outcome and logs at notice.
  errors: [
    {
      reason: 'zone_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Zone code is not a valid NWS forecast zone',
      recovery:
        'Use an affectedZones entry from nws_search_alerts whose type is "forecast" (entries typed "county" have no forecast product), the "forecastZone" field from nws_get_forecast, or the "forecastZone" column from nws_find_stations. Zone codes follow the pattern XXZ### (e.g., "WAZ315"). For an entry typed "fire", call nws_get_office_discussion with office set to the alert\'s "office" field, product_type "FWF", and sections set to the zone code.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'zone_forecast_unavailable',
      code: JsonRpcErrorCode.NotFound,
      when: 'Zone is a valid land forecast zone, but NWS has no text forecast for it',
      recovery:
        'Call nws_get_forecast with coordinates inside this zone for its point forecast; NWS usually serves one where a zone has no zone text product.',
      // Also raised when the zone forecast endpoint fails outright while the zone
      // record answers, so an outage of that endpoint alone surfaces only as this
      // reason: warning keeps it visible without counting it as a fault.
      severity: 'warning',
      thrownBy: 'service',
    },
    {
      reason: 'marine_forecast_unsupported',
      code: JsonRpcErrorCode.NotFound,
      when: 'Zone is a marine forecast zone NWS publishes no text forecast for (availability varies by zone family)',
      recovery:
        'Use nws_search_alerts with this zone code for marine hazards, or nws_get_forecast with coordinates on nearby land for a land forecast. Coastal zones starting AMZ, ANZ, GMZ, PHZ, or PZZ usually have a text forecast; Great Lakes, most Alaska, Guam, American Samoa, and offshore zones have none.',
      severity: 'notice',
      thrownBy: 'service',
    },
  ],

  input: z.object({
    zone_id: z
      .string()
      .trim()
      .min(1)
      .meta({ pattern: ZONE_ID_INPUT_PATTERN.source })
      .describe(
        'NWS forecast zone code (e.g., "WAZ315" for the City of Seattle, or a marine zone such as "PZZ251"). Returned as "forecastZone" by nws_get_forecast and nws_find_stations, or as the "code" of an "affectedZones" entry with type "forecast" in nws_search_alerts. Format: two-letter state or marine area code + "Z" + three-digit number.',
      ),
  }),

  output: z.object({
    zoneId: z.string().describe('Zone ID, uppercased (e.g., "WAZ315" for input "waz315").'),
    updated: z
      .string()
      .describe(
        "When the zone forecast was last updated (ISO 8601 with NWS's timezone offset): the issuance time of the product it comes from. A value NWS sent 12 hours off is corrected, and notice names the value NWS sent; a value later than the response that cannot be corrected is returned as sent, with a notice.",
      ),
    periods: z
      .array(
        z
          .object({
            number: z.number().describe('Period sequence number, starting at 1.'),
            name: z.string().describe('Period name (e.g., "Today", "Tonight", "Monday").'),
            detailedForecast: z
              .string()
              .describe(
                'Full narrative forecast for this period, written by local forecasters (e.g., "Partly cloudy. Highs in the upper 60s. Southwest winds 10 to 15 mph.").',
              ),
          })
          .describe('Single forecast period with name and narrative'),
      )
      .describe('Forecast periods in chronological order, typically covering 7 days.'),
  }),

  // Result-set context for the agent — period count so agents know forecast length.
  enrichment: {
    periodCount: z.number().describe('Number of forecast periods returned.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Set when updated differs from the value NWS sent (12 hours off, which it names), or when NWS sent a time later than the response that is returned as sent and cannot be trusted.',
      ),
  },

  enrichmentTrailer: {
    periodCount: { label: 'Periods' },
    notice: { render: (value) => `> ${escapeMarkdownInline(String(value))}` },
  },

  async handler(input, ctx) {
    const zoneId = input.zone_id.toUpperCase();
    const result = await getNwsService().getZoneForecast(zoneId, ctx);
    const { updated, notice } = readUpdated(result.updated, Date.now());

    ctx.enrich({ periodCount: result.periods.length });
    if (notice) ctx.enrich.notice(notice);

    return {
      zoneId: result.zoneId,
      updated,
      periods: result.periods.map((p) => ({
        number: p.number,
        name: p.name,
        detailedForecast: p.detailedForecast,
      })),
    };
  },

  format: (result) => {
    const lines = [
      `## Zone Forecast: ${escapeMarkdownInline(result.zoneId)}`,
      `**Updated:** ${escapeMarkdownInline(result.updated)}`,
      '',
    ];

    for (const p of result.periods) {
      lines.push(`### ${p.number}. ${escapeMarkdownInline(p.name)}`);
      lines.push(escapeMarkdownInline(p.detailedForecast));
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
