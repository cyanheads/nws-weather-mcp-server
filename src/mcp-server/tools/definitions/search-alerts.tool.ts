/**
 * @fileoverview Tool: nws_search_alerts — searches active weather alerts across the US.
 * @module mcp-server/tools/definitions/search-alerts
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor, escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getNwsService } from '@/services/nws/nws-service.js';
import { alertMarkdownLines, alertOutputSchema, toAlertOutput } from '../alert-output.js';
import {
  clampPageLimit,
  composeNotice,
  invalidCursor,
  LIMIT_CEILING,
  type PageLimit,
  validatePageWindow,
} from '../page-limit.js';
import { unsetIfBlank } from '../unset-if-blank.js';

/**
 * Upper bound on alerts per page. `/alerts/active` rejects an upstream `limit`,
 * so the service fetches and filters the whole active collection and this tool
 * windows the result. Matches past the window are reachable through the
 * `nextCursor` continuation token. A larger `limit` is served up to this cap
 * rather than rejected.
 */
const MAX_ALERTS = 25;

/**
 * Filters that scope the search geographically. NWS rejects any pairing of these
 * with a 400 — including region_type with region, which are incompatible with
 * each other as well as with area/point/zone — so one mutual-exclusion check
 * over the whole set covers every combination.
 */
const LOCATION_FILTER_FIELDS = ['area', 'point', 'zone', 'region_type', 'region'] as const;

/** NWS marine region groups from the upstream MarineRegionCode enumeration. */
const MARINE_REGIONS = ['AL', 'AT', 'GL', 'GM', 'PA', 'PI'] as const;

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

/**
 * Shapes advertised as JSON Schema `pattern`s on area, point, and zone (issue #54).
 * A validating client applies a pattern to the raw value, so each admits every form
 * the handler accepts before it normalizes: any case, surrounding whitespace, a blank
 * or whitespace-only value (unset), and for point whitespace anywhere, which the
 * handler strips. Enforcement stays in the handler checks above — area and prefix
 * sets, coordinate bounds — with their declared reasons; a Zod `.regex()` would
 * reject first as a generic -32602. The trailing `\s*` sits inside the optional
 * group, and a minus sign carries its own `\s*`, so no two whitespace runs can split
 * one stretch of input between them and a backtracking engine stays linear on long
 * whitespace.
 */
export const AREA_INPUT_PATTERN = /^\s*(?:[A-Za-z]{2}\s*)?$/;
export const POINT_INPUT_PATTERN =
  /^\s*(?:(?:-\s*)?\d(?:\s*\d)*(?:\s*\.\s*\d(?:\s*\d)*)?\s*,\s*(?:-\s*)?\d(?:\s*\d)*(?:\s*\.\s*\d(?:\s*\d)*)?\s*)?$/;
export const ZONE_INPUT_PATTERN = /^\s*(?:[A-Za-z]{2}[CcZz]\d{3}\s*)?$/;

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

/** The applied-filters echo of a search with no filters. */
const NATIONAL_SEARCH = 'national (no filters)';

/**
 * Build a human-readable summary of the applied search filters from the
 * normalized filters, where a blank string or empty array is already unset.
 */
function describeFilters(filters: SearchFilters): string {
  const parts: string[] = [];
  if (filters.area) parts.push(`area=${filters.area}`);
  if (filters.point) parts.push(`point=${filters.point}`);
  if (filters.zone) parts.push(`zone=${filters.zone}`);
  if (filters.region_type) parts.push(`region_type=${filters.region_type}`);
  if (filters.region) parts.push(`region=${filters.region.join(', ')}`);
  if (filters.event) parts.push(`event=${filters.event.join(', ')}`);
  if (filters.severity) parts.push(`severity=${filters.severity.join(', ')}`);
  if (filters.urgency) parts.push(`urgency=${filters.urgency.join(', ')}`);
  if (filters.certainty) parts.push(`certainty=${filters.certainty.join(', ')}`);
  if (filters.status && filters.status !== 'Actual') parts.push(`status=${filters.status}`);
  return parts.length > 0 ? parts.join(', ') : NATIONAL_SEARCH;
}

/** An empty array filters nothing, so it is unset like an omitted one (issue #46). */
function nonEmpty<T>(values: T[] | undefined): T[] | undefined {
  return values?.length ? values : undefined;
}

/**
 * Trim free-text event terms and drop blanks, so the terms the service filters on
 * are exactly the terms `describeFilters()` echoes back (issue #30). An array of
 * nothing but blanks is unset.
 */
function normalizeEventFilter(events: string[] | undefined): string[] | undefined {
  return nonEmpty(events?.map((event) => event.trim()).filter((event) => event.length > 0));
}

/**
 * Reduce blank filters to unset and normalize the rest, keeping only the filter
 * fields; mutex and shape checks come after. `point` also drops internal whitespace
 * so "47.6, -122.3" salvages to the NWS-accepted "47.6,-122.3"; `zone` is upper-cased
 * like `area` and the sibling zone tools so "waz315" doesn't trip the upstream
 * zone-code regex (issue #20).
 */
function normalizeFilters(filters: SearchFilters): SearchFilters {
  return {
    area: unsetIfBlank(filters.area)?.toUpperCase(),
    point: unsetIfBlank(filters.point)?.replace(/\s+/g, ''),
    zone: unsetIfBlank(filters.zone)?.toUpperCase(),
    region_type: filters.region_type,
    region: nonEmpty(filters.region),
    event: normalizeEventFilter(filters.event),
    severity: nonEmpty(filters.severity),
    urgency: nonEmpty(filters.urgency),
    certainty: nonEmpty(filters.certainty),
    status: filters.status,
  };
}

/** The location filters that carry a value; NWS accepts at most one. */
function locationFiltersSet(filters: SearchFilters): string[] {
  return LOCATION_FILTER_FIELDS.filter((fieldName) => filters[fieldName] !== undefined);
}

/** A normalized point NWS accepts: "lat,lon" within coordinate bounds. */
function isValidPoint(point: string): boolean {
  const match = NWS_POINT_PATTERN.exec(point);
  if (!match) return false;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/** A normalized zone code in the NWS zone-code shape, with a real area prefix. */
function isValidZone(zone: string): boolean {
  const [, areaPrefix] = NWS_ZONE_PATTERN.exec(zone) ?? [];
  return areaPrefix !== undefined && VALID_AREA_CODES.has(areaPrefix);
}

/**
 * Whether normalized filters pass every check the handler applies to the filter
 * inputs: one location filter at most, and a valid area, point, and zone.
 */
function passesFilterChecks(filters: SearchFilters): boolean {
  return (
    locationFiltersSet(filters).length <= 1 &&
    (filters.area === undefined || VALID_AREA_CODES.has(filters.area)) &&
    (filters.point === undefined || isValidPoint(filters.point)) &&
    (filters.zone === undefined || isValidZone(filters.zone))
  );
}

/**
 * Where a continued page resumes. A token this tool mints carries the normalized
 * filters of the query that minted it; a token from before the query was carried
 * (`{ offset, limit }` alone) has no `filters` and resumes against the filters
 * sent with it.
 */
interface Continuation {
  filters?: SearchFilters | undefined;
  limit: number;
  offset: number;
}

const INVALID_CURSOR_HINT =
  'Omit `cursor` and send the filters to start from the first page, or pass the `nextCursor` from the previous response unchanged.';

/**
 * Decode a continuation token before any request. Fails as InvalidParams
 * (`invalid_cursor`) for a token that does not decode, carries a non-integer
 * offset or limit, or carries filters that fail the input schema or the checks
 * the filter inputs get.
 */
function readCursor(cursor: string, ctx: Context): Continuation {
  const { offset, limit, filters } = decodeCursor(cursor, ctx);
  validatePageWindow(offset, limit, cursor, INVALID_CURSOR_HINT);
  if (filters === undefined) return { offset, limit };
  const parsed = carriedFiltersSchema.safeParse(filters);
  if (!parsed.success) throw invalidCursor(cursor, INVALID_CURSOR_HINT);
  const carried = normalizeFilters(parsed.data);
  if (!passesFilterChecks(carried)) throw invalidCursor(cursor, INVALID_CURSOR_HINT);
  return { offset, limit, filters: carried };
}

/**
 * A blank enum from a form client is unset, never a value to validate: `""` maps
 * to undefined before the enum runs, so an optional enum drops out and a defaulted
 * one takes its default. The advertised schema is the inner enum's.
 */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const searchAlertsInputSchema = z.object({
  area: z
    .string()
    .optional()
    .meta({ pattern: AREA_INPUT_PATTERN.source })
    .describe(
      'US state/territory code (e.g., "WA", "OK", "PR") or marine area code (e.g., "GM"). Mutually exclusive with point and zone.',
    ),
  point: z
    .string()
    .optional()
    .meta({ pattern: POINT_INPUT_PATTERN.source })
    .describe(
      'Coordinates as "lat,lon" (e.g., "47.6,-122.3"). Returns alerts whose geometry contains this point. Mutually exclusive with area and zone.',
    ),
  zone: z
    .string()
    .optional()
    .meta({ pattern: ZONE_INPUT_PATTERN.source })
    .describe(
      'NWS forecast zone (e.g., "WAZ558") or county zone (e.g., "WAC033"). Mutually exclusive with area and point.',
    ),
  region_type: blankAsUnset(z.enum(['Land', 'Marine']).optional()).describe(
    'Restrict to land-based or marine alerts. Mutually exclusive with area, point, zone, and region.',
  ),
  region: z
    .array(z.enum(MARINE_REGIONS))
    .optional()
    .describe(
      'Restrict to NWS marine region groups: "AL" (Alaska waters), "AT" (Atlantic Ocean), "GL" (Great Lakes), "GM" (Gulf of Mexico), "PA" (Eastern Pacific and US West Coast), "PI" (Central and Western Pacific). Marine alerts only — a land alert never matches. Mutually exclusive with area, point, zone, and region_type.',
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
  status: blankAsUnset(
    z.enum(['Actual', 'Exercise', 'System', 'Test', 'Draft']).default('Actual'),
  ).describe(
    'Alert status filter. Default "Actual". Use a different value only when you specifically need non-live alerts.',
  ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIMIT_CEILING)
    .default(MAX_ALERTS)
    .describe(
      `Maximum number of alerts to include in this page (default ${MAX_ALERTS}). A page holds at most ${MAX_ALERTS}; a larger limit (up to ${LIMIT_CEILING}) is served as ${MAX_ALERTS} and reported through requestedLimit and effectiveLimit. totalCount still reports the full number of distinct matches, so a small limit returns a digest of broad or national searches without dropping the total; pass the returned nextCursor as cursor to reach the rest.`,
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque continuation token from a previous response's nextCursor; send it on its own. Omit for the first page. It carries that query's filters and page size, so the filter inputs and limit apply to the first page only. Every call re-fetches the active-alert feed, so alerts are contiguous within one response but not across calls — the active set changes continuously as alerts are issued and expire, so a continued page covers the collection as it stands at that moment.",
    ),
});

/**
 * The filter fields of the input, which a continuation token carries. Strict, as
 * the input is: a carried key that is not a filter is refused, not stripped.
 */
const carriedFiltersSchema = searchAlertsInputSchema.omit({ limit: true, cursor: true }).strict();

type SearchFilters = z.infer<typeof carriedFiltersSchema>;

export const searchAlertsTool = tool('nws_search_alerts', {
  description:
    'Search active weather alerts (watches, warnings, advisories) across the US. Filter by state, coordinates, zone, land/marine region, event type, severity, urgency, or certainty. area, point, zone, region_type, and region are mutually exclusive — provide at most one. Omit all filters for a national search.',
  annotations: { readOnlyHint: true },
  // Every reason is caller input NWS cannot serve, so each logs at notice rather
  // than error. All are rejected before any request except invalid_point, which
  // the service also raises when NWS refuses a well-formed point outside its
  // coverage.
  errors: [
    {
      reason: 'mutually_exclusive_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than one of area, point, zone, region_type, or region provided',
      recovery:
        'Provide at most one of area, point, zone, region_type, or region — they are mutually exclusive filters.',
      severity: 'notice',
    },
    {
      reason: 'invalid_area_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Area code is not a recognized US state, territory, or marine area',
      recovery:
        'Provide a 2-letter US state/territory code (e.g., "WA") or marine area code (e.g., "GM").',
      severity: 'notice',
    },
    {
      reason: 'invalid_point',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Point coordinates are malformed, outside valid bounds, or outside NWS coverage (US states, territories, and adjacent marine areas)',
      recovery:
        'Provide "lat,lon" with latitude -90 to 90 and longitude -180 to 180 (e.g., "47.6,-122.3") for a location NWS covers: the US states, territories, or adjacent marine areas.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_zone',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Zone code does not match the NWS zone-code shape',
      recovery:
        'Provide a 2-letter state/territory or marine code, then C for a county zone or Z for a forecast zone, then 3 digits (e.g., "WAZ558", "WAC033"). Zone codes come from affectedZones in nws_search_alerts, forecastZone in nws_get_forecast, or forecastZone in nws_find_stations.',
      severity: 'notice',
    },
  ],

  input: searchAlertsInputSchema,

  output: z.object({
    alerts: z
      .array(alertOutputSchema)
      .describe(
        `Matching alerts for this page (at most the applied limit, which never exceeds ${MAX_ALERTS})`,
      ),
  }),

  // Result-set context the agent reasons with — counts, applied filters echo, and empty-result
  // guidance. Populated via ctx.enrich(...) so it reaches structuredContent and content[] alike;
  // kept out of the domain return.
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total distinct alerts matching the filters in this fetch, before the page window is applied. NWS repeats some alerts verbatim within one response; the copies are collapsed on id, so this counts each alert once. Compare against shown to tell whether matches were withheld from this page.',
      ),
    shown: z.number().describe('Number of alerts included in this response'),
    appliedFilters: z.string().describe('Summary of applied search filters'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        "Opaque token for the next page of matches — pass it back as `cursor` on its own; it carries this query's filters and page size. Omitted when this is the last page.",
      ),
    requestedLimit: z
      .number()
      .optional()
      .describe(
        `The limit asked for, when it exceeded the ${MAX_ALERTS}-alert page cap; absent otherwise.`,
      ),
    effectiveLimit: z
      .number()
      .optional()
      .describe(
        'The page size applied instead of requestedLimit; continued pages keep it. Absent when the limit was within the cap.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the requested limit exceeded the page cap, when no alerts matched (echoes applied filters and suggests how to broaden), when matches remain beyond this page, or when the supplied cursor points past the end of the match set.',
      ),
  },

  enrichmentTrailer: {
    notice: { render: (value) => `> ${escapeMarkdownInline(String(value))}` },
    totalCount: { label: 'Total Alerts' },
    shown: { label: 'Shown' },
    appliedFilters: { label: 'Filters' },
    nextCursor: { label: 'Next Cursor' },
    requestedLimit: { label: 'Requested Limit' },
    effectiveLimit: { label: 'Applied Limit' },
  },

  async handler(input, ctx) {
    // The token is decoded before any request, so one this tool never minted
    // costs no fetch. A token it minted carries its query, which governs the
    // continued page: the filter inputs, like limit, shape the first page only.
    // A token without filters resumes against the filter inputs.
    const cursor = unsetIfBlank(input.cursor);
    const continuation = cursor === undefined ? undefined : readCursor(cursor, ctx);
    // Blanks are unset from here on, so only filters that carry a value count
    // toward mutual exclusion and reach the shape checks below (issue #46).
    const filters = continuation?.filters ?? normalizeFilters(input);

    const activeLocationFilters = locationFiltersSet(filters);
    if (activeLocationFilters.length > 1) {
      throw ctx.fail(
        'mutually_exclusive_filters',
        `Provided ${activeLocationFilters.join(', ')}; only one of area, point, zone, region_type, or region is allowed.`,
      );
    }

    if (filters.area && !VALID_AREA_CODES.has(filters.area)) {
      throw ctx.fail(
        'invalid_area_code',
        `Invalid area code "${filters.area}". Use a 2-letter US state/territory code (e.g., "WA", "OK", "PR") or marine area code (e.g., "GM").`,
      );
    }

    if (filters.point && !isValidPoint(filters.point)) {
      throw ctx.fail(
        'invalid_point',
        `Invalid point "${filters.point}". Provide "lat,lon" with latitude -90 to 90 and longitude -180 to 180 (e.g., "47.6,-122.3").`,
      );
    }

    if (filters.zone && !isValidZone(filters.zone)) {
      throw ctx.fail(
        'invalid_zone',
        `Invalid zone "${filters.zone}". Provide a 2-letter state/territory or marine code, then C or Z, then 3 digits (e.g., "WAZ558", "WAC033").`,
      );
    }

    // The service collapses upstream duplicates on id (issue #36), so this is a
    // distinct-alert count, which is what `totalCount` reports.
    const result = await getNwsService().searchAlerts(filters, ctx);
    const total = result.alerts.length;
    const appliedFilters = describeFilters(filters);

    // The fetched, filtered match set is windowed here — `/alerts/active` takes
    // no upstream limit or cursor, so continuation is local to this array. The
    // cursor carries its own page size, held to the cap; a first page holds
    // `limit` to the cap and discloses the clamp.
    const { effectiveLimit, clamp }: PageLimit = continuation
      ? { effectiveLimit: Math.min(continuation.limit, MAX_ALERTS) }
      : clampPageLimit(input.limit, MAX_ALERTS);
    const offset = continuation?.offset ?? 0;
    const items = result.alerts.slice(offset, offset + effectiveLimit);
    const nextCursor =
      offset + effectiveLimit < total
        ? encodeCursor({ offset: offset + effectiveLimit, limit: effectiveLimit, filters })
        : undefined;

    ctx.log.info('Alerts search completed', { total, shown: items.length, appliedFilters });

    ctx.enrich({
      totalCount: total,
      shown: items.length,
      appliedFilters,
      ...(nextCursor ? { nextCursor } : {}),
      ...clamp?.fields,
    });
    let pageNotice: string | undefined;
    if (total === 0) {
      pageNotice = `No active alerts matched: ${appliedFilters}. Try a broader area, remove severity or event filters, or use nws_list_alert_types to verify event names.`;
    } else if (nextCursor) {
      pageNotice = `Returning ${items.length} of ${total} matching alerts. Pass nextCursor back as cursor for the next page. Alerts are contiguous within this response only — every call re-fetches the active-alert feed, so a continued page covers the collection as it stands at that moment, and alerts issued or expired in between can shift entries across the page boundary. Duplicate alerts are collapsed on id within each fetch, so the same id arriving on two pages means the active set moved between calls, not that one alert was returned twice.`;
    } else if (continuation && items.length === 0) {
      const restart =
        appliedFilters === NATIONAL_SEARCH
          ? `Call again with limit ${effectiveLimit} and no cursor to restart from the first match.`
          : `To restart from the first match, call again with those filters, limit ${effectiveLimit}, and no cursor.`;
      pageNotice = `The cursor points past the end of the ${total} alerts matching: ${appliedFilters}. ${restart}`;
    }
    const notice = composeNotice(clamp?.notice, pageNotice);
    if (notice) ctx.enrich.notice(notice);

    return { alerts: items.map(toAlertOutput) };
  },

  format: (result) => {
    if (result.alerts.length === 0) {
      return [
        {
          type: 'text',
          text: 'No active alerts matched. See the enrichment block below for filters and recovery guidance.',
        },
      ];
    }

    const lines = [
      `## ${result.alerts.length} Active Alert${result.alerts.length === 1 ? '' : 's'}\n`,
    ];

    for (const alert of result.alerts) {
      lines.push(...alertMarkdownLines(alert), '', '---', '');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
