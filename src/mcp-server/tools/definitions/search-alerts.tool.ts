/**
 * @fileoverview Tool: nws_search_alerts — searches active weather alerts across the US.
 * @module mcp-server/tools/definitions/search-alerts
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNwsService } from '@/services/nws/nws-service.js';
import { formatTimestamp, zoneCodeToTimeZone } from '../format-utils.js';

const MAX_ALERTS = 25;
const LOCATION_FILTER_FIELDS = ['area', 'point', 'zone'] as const;
const ARRAY_FILTER_FIELDS = ['event', 'severity', 'urgency', 'certainty'] as const;

/**
 * Strict coordinate pattern NWS enforces on the /alerts/active `point` filter.
 * Validating against it locally rejects malformed points ("47.6,", a lone value,
 * whitespace-split segments) with the declared invalid_point recovery instead of
 * leaking a raw upstream regex 400 (issue #20). A plain `.split(',').map(Number)`
 * let blank/padded segments coerce to 0 and slip through.
 */
const NWS_POINT_PATTERN = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

/**
 * Shape NWS enforces on the /alerts/active `zone` filter: a 2-letter area prefix,
 * a C (county) or Z (forecast) infix, and exactly 3 digits. The prefix is checked
 * against VALID_AREA_CODES rather than a bare [A-Z]{2} wildcard — that set is
 * character-for-character the enumeration in NWS's own zone-code pattern, and
 * "QQZ123" satisfies the wildcard while still leaking a raw upstream 400 (issue #20).
 * A real prefix with no matching zone ("WAZ999") stays valid here: NWS answers it
 * with a clean zero-result search.
 */
const NWS_ZONE_PATTERN = /^([A-Z]{2})[CZ]\d{3}$/;

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

/**
 * Trim optional string filters and reduce blank values to undefined. Presence is
 * read from the raw input before this runs — once collapsed, `undefined` means
 * both "omitted" and "explicitly blank" (issue #30).
 */
function normalizeOptionalFilter(value: string | undefined): string | undefined {
  if (value == null) return;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Trim free-text event terms and drop blanks, so the terms the service filters on
 * are exactly the terms `describeFilters()` echoes back (issue #30). The enum-typed
 * arrays need no equivalent — Zod constrains them to exact literals.
 */
function normalizeEventFilter(events: string[] | undefined): string[] | undefined {
  if (events == null) return;
  return events.map((event) => event.trim()).filter((event) => event.length > 0);
}

/**
 * Trim and normalize optional filters; presence and mutex enforcement happen in the
 * handler. `point` also drops internal whitespace so "47.6, -122.3" salvages to
 * the NWS-accepted "47.6,-122.3"; `zone` is upper-cased like `area` and the
 * sibling zone tools so "waz315" doesn't trip the upstream zone-code regex (issue #20).
 */
function normalizeSearchAlertsInput(input: SearchAlertsInput): SearchAlertsInput {
  return {
    ...input,
    area: normalizeOptionalFilter(input.area)?.toUpperCase(),
    point: normalizeOptionalFilter(input.point)?.replace(/\s+/g, ''),
    zone: normalizeOptionalFilter(input.zone)?.toUpperCase(),
    event: normalizeEventFilter(input.event),
  };
}

const searchAlertsInputSchema = z.object({
  area: z
    .string()
    .optional()
    .describe(
      'US state/territory code (e.g., "WA", "OK", "PR") or marine area code (e.g., "GM"). Mutually exclusive with point and zone.',
    ),
  point: z
    .string()
    .optional()
    .describe(
      'Coordinates as "lat,lon" (e.g., "47.6,-122.3"). Returns alerts whose geometry contains this point. Mutually exclusive with area and zone.',
    ),
  zone: z
    .string()
    .optional()
    .describe(
      'NWS forecast zone (e.g., "WAZ558") or county zone (e.g., "WAC033"). Mutually exclusive with area and point.',
    ),
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
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ALERTS)
    .default(MAX_ALERTS)
    .describe(
      'Maximum number of alerts to include in the response (1-25, default 25). totalCount still reports the full number of matches, so a small limit returns a digest of broad or national searches without dropping the total.',
    ),
});

type SearchAlertsInput = z.infer<typeof searchAlertsInputSchema>;

export const searchAlertsTool = tool('nws_search_alerts', {
  description:
    'Search active weather alerts (watches, warnings, advisories) across the US. Filter by state, coordinates, zone, event type, severity, urgency, or certainty. area, point, and zone are mutually exclusive. Omit all filters for a national search.',
  annotations: { readOnlyHint: true },
  errors: [
    {
      reason: 'mutually_exclusive_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than one of area, point, or zone provided',
      recovery:
        'Provide at most one of area, point, or zone — they are mutually exclusive filters.',
    },
    {
      reason: 'invalid_area_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Area code is not a recognized US state, territory, or marine area',
      recovery:
        'Provide a 2-letter US state/territory code (e.g., "WA") or marine area code (e.g., "GM").',
    },
    {
      reason: 'invalid_point',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Point coordinates are malformed or outside valid bounds',
      recovery:
        'Provide "lat,lon" with latitude -90 to 90 and longitude -180 to 180 (e.g., "47.6,-122.3").',
    },
    {
      reason: 'invalid_zone',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Zone code does not match the NWS zone-code shape',
      recovery:
        'Provide a 2-letter state/territory or marine code, then C for a county zone or Z for a forecast zone, then 3 digits (e.g., "WAZ558", "WAC033"). Zone codes come from affectedZones in nws_search_alerts, forecastZone in nws_get_forecast, or forecastZone in nws_find_stations.',
    },
    {
      reason: 'blank_location_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An area, point, or zone filter was provided with a blank value',
      recovery:
        'Omit the filter entirely to search nationally, or provide a real area, point, or zone value.',
    },
    {
      reason: 'empty_filter_array',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An event, severity, urgency, or certainty filter was provided with no usable entries',
      recovery:
        'Omit the filter entirely to leave it unset, or provide at least one non-blank entry.',
    },
  ],

  input: searchAlertsInputSchema,

  output: z.object({
    alerts: z
      .array(
        z
          .object({
            id: z.string().describe('Alert ID'),
            event: z.string().describe('Event type (e.g., "Tornado Warning")'),
            headline: z.string().nullable().describe('Alert headline'),
            description: z.string().describe('Full alert description'),
            instruction: z.string().nullable().describe('Recommended actions'),
            severity: z.string().describe('Severity level'),
            urgency: z.string().describe('Urgency level'),
            certainty: z.string().describe('Certainty level'),
            areaDesc: z.string().describe('Affected area description'),
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
            senderName: z.string().describe('Issuing office'),
            affectedZones: z.array(z.string()).describe('Affected zone codes'),
          })
          .describe('Single active alert with event, severity, area, and timing'),
      )
      .describe('Matching alerts (capped at the requested limit, max 25)'),
  }),

  // Result-set context the agent reasons with — counts, applied filters echo, and empty-result
  // guidance. Populated via ctx.enrich(...) so it reaches structuredContent and content[] alike;
  // kept out of the domain return.
  enrichment: {
    totalCount: z
      .number()
      .describe('Total number of matching alerts before the limit/cap is applied'),
    shownCount: z.number().describe('Number of alerts included in this response'),
    appliedFilters: z.string().describe('Summary of applied search filters'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no alerts matched — echoes applied filters and suggests how to broaden the search.',
      ),
  },

  enrichmentTrailer: {
    totalCount: { label: 'Total Alerts' },
    shownCount: { label: 'Shown' },
    appliedFilters: { label: 'Filters' },
  },

  async handler(input, ctx) {
    const normalizedInput = normalizeSearchAlertsInput(input);

    // Presence comes from the raw input: normalization reduces a blank value to
    // undefined, which is also what an omitted filter looks like. Reading presence
    // after that step is what let a blank filter widen into a national search (issue #30).
    const blankLocationFilters = LOCATION_FILTER_FIELDS.filter(
      (fieldName) => input[fieldName] !== undefined && normalizedInput[fieldName] === undefined,
    );
    if (blankLocationFilters.length > 0) {
      throw ctx.fail(
        'blank_location_filter',
        `Blank location filter${blankLocationFilters.length === 1 ? '' : 's'}: ${blankLocationFilters.map((fieldName) => `"${fieldName}"`).join(', ')}. A provided area, point, or zone must carry a value.`,
        { ...ctx.recoveryFor('blank_location_filter') },
      );
    }

    const emptyArrayFilters = ARRAY_FILTER_FIELDS.filter(
      (fieldName) => input[fieldName] !== undefined && !normalizedInput[fieldName]?.length,
    );
    if (emptyArrayFilters.length > 0) {
      const detail = emptyArrayFilters
        .map(
          (fieldName) =>
            `"${fieldName}" (${input[fieldName]?.length ? 'only blank entries' : 'empty array'})`,
        )
        .join(', ');
      throw ctx.fail(
        'empty_filter_array',
        `Filter${emptyArrayFilters.length === 1 ? '' : 's'} with no usable entries: ${detail}. Each one filters nothing.`,
        { ...ctx.recoveryFor('empty_filter_array') },
      );
    }

    const activeLocationFilters = LOCATION_FILTER_FIELDS.filter(
      (fieldName) => normalizedInput[fieldName],
    );
    if (activeLocationFilters.length > 1) {
      throw ctx.fail(
        'mutually_exclusive_filters',
        `Provided ${activeLocationFilters.join(', ')}; only one of area, point, or zone is allowed.`,
        { ...ctx.recoveryFor('mutually_exclusive_filters') },
      );
    }

    if (normalizedInput.area && !VALID_AREA_CODES.has(normalizedInput.area)) {
      throw ctx.fail(
        'invalid_area_code',
        `Invalid area code "${normalizedInput.area}". Use a 2-letter US state/territory code (e.g., "WA", "OK", "PR") or marine area code (e.g., "GM").`,
        { ...ctx.recoveryFor('invalid_area_code') },
      );
    }

    if (normalizedInput.point) {
      const match = NWS_POINT_PATTERN.exec(normalizedInput.point);
      const lat = match ? Number(match[1]) : Number.NaN;
      const lon = match ? Number(match[2]) : Number.NaN;
      if (!match || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        throw ctx.fail(
          'invalid_point',
          `Invalid point "${normalizedInput.point}". Provide "lat,lon" with latitude -90 to 90 and longitude -180 to 180 (e.g., "47.6,-122.3").`,
          { ...ctx.recoveryFor('invalid_point') },
        );
      }
    }

    if (normalizedInput.zone) {
      const [, areaPrefix] = NWS_ZONE_PATTERN.exec(normalizedInput.zone) ?? [];
      if (areaPrefix == null || !VALID_AREA_CODES.has(areaPrefix)) {
        throw ctx.fail(
          'invalid_zone',
          `Invalid zone "${normalizedInput.zone}". Provide a 2-letter state/territory or marine code, then C or Z, then 3 digits (e.g., "WAZ558", "WAC033").`,
          { ...ctx.recoveryFor('invalid_zone') },
        );
      }
    }

    const result = await getNwsService().searchAlerts(normalizedInput, ctx);
    const total = result.alerts.length;
    const capped = result.alerts.slice(0, normalizedInput.limit);
    const appliedFilters = describeFilters(normalizedInput);

    ctx.log.info('Alerts search completed', { total, shown: capped.length, appliedFilters });

    ctx.enrich({ totalCount: total, shownCount: capped.length, appliedFilters });
    if (total === 0) {
      ctx.enrich.notice(
        `No active alerts matched: ${appliedFilters}. Try a broader area, remove severity or event filters, or use nws_list_alert_types to verify event names.`,
      );
    }

    return {
      alerts: capped.map((a) => ({ ...a, affectedZones: [...a.affectedZones] })),
    };
  },

  format: (result) => {
    if (result.alerts.length === 0) {
      return [
        {
          type: 'text',
          text: 'No active alerts matched. See the enrichment block above for filters and recovery guidance.',
        },
      ];
    }

    const lines = [
      `## ${result.alerts.length} Active Alert${result.alerts.length === 1 ? '' : 's'}\n`,
    ];

    for (const a of result.alerts) {
      // Derive a representative IANA zone from the first affected zone code so
      // alert timestamps render with named US abbreviations (PDT/CDT/EDT) like
      // forecast/observations, rather than falling back to numeric UTC offsets.
      const alertTimeZone = zoneCodeToTimeZone(a.affectedZones[0]);

      lines.push(`### ${a.event}`);
      lines.push(`_ID: ${a.id}_`);
      if (a.headline) lines.push(`**${a.headline}**`);
      lines.push(
        `**Severity:** ${a.severity} | **Urgency:** ${a.urgency} | **Certainty:** ${a.certainty}`,
      );
      lines.push(`**Area:** ${a.areaDesc}`);
      if (a.onset) lines.push(`**Hazard onset:** ${formatTimestamp(a.onset, alertTimeZone)}`);
      if (a.ends) lines.push(`**Hazard ends:** ${formatTimestamp(a.ends, alertTimeZone)}`);
      if (a.expires) {
        lines.push(`**Message valid until:** ${formatTimestamp(a.expires, alertTimeZone)}`);
      }
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

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
