/**
 * @fileoverview Tool: nws_search_alerts — searches active weather alerts across the
 * US, or the alert messages issued in a recent time window.
 * @module mcp-server/tools/definitions/search-alerts
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor, escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getNwsService } from '@/services/nws/nws-service.js';
import type { Alert } from '@/services/nws/types.js';
import { alertMarkdownLines, alertOutputSchema, toAlertOutput } from '../alert-output.js';
import { DATE_TIME_INPUT_PATTERN, parseDateTime } from '../date-time.js';
import {
  clampPageLimit,
  composeNotice,
  invalidCursor,
  type PageLimit,
  validatePageWindow,
} from '../page-limit.js';
import { unsetIfBlank } from '../unset-if-blank.js';

/**
 * Upper bound on alerts per page. `/alerts/active` rejects an upstream `limit`,
 * so the service fetches and filters the whole active collection and this tool
 * windows the result; a windowed search asks `/alerts` for one page at a time.
 * Matches past the window are reachable through the `nextCursor` continuation
 * token. A larger `limit` is served up to this cap rather than rejected.
 */
const MAX_ALERTS = 25;

/** NWS's ceiling on an `/alerts` request's `limit`; a larger one is a 400. */
const MAX_UPSTREAM_LIMIT = 500;

/**
 * NWS keeps alert messages for a rolling 7 days. Its purge runs a few minutes behind
 * that mark, so `/alerts` can still serve a message sent just before it.
 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  if (filters.message_type) parts.push(`message_type=${filters.message_type}`);
  if (filters.status && filters.status !== 'Actual') parts.push(`status=${filters.status}`);
  if (filters.start) parts.push(`start=${filters.start}`);
  if (filters.end) parts.push(`end=${filters.end}`);
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
 * A blank date-time is unset; one that parses takes its canonical spelling, the
 * form sent upstream and carried in a cursor; any other stays as sent, for the
 * window check to refuse.
 */
function normalizeDateTime(value: string | undefined): string | undefined {
  const trimmed = unsetIfBlank(value);
  return trimmed === undefined ? undefined : (parseDateTime(trimmed)?.text ?? trimmed);
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
    message_type: filters.message_type,
    status: filters.status,
    start: normalizeDateTime(filters.start),
    end: normalizeDateTime(filters.end),
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

/** Whether a search covers an issuance window (`/alerts`) rather than the active alerts. */
function isWindowed(filters: SearchFilters): boolean {
  return filters.start !== undefined || filters.end !== undefined;
}

/**
 * What is wrong with a normalized window, or undefined when it is valid or there is
 * none. `start` alone, `end` alone, and `start` equal to `end` are all windows NWS
 * serves: both ends are inclusive. NWS answers a calendar-invalid date-time with a
 * 500, so nothing here reaches it unchecked.
 */
function timeWindowProblem(filters: SearchFilters): string | undefined {
  const { start, end } = filters;
  const startTime = start === undefined ? undefined : parseDateTime(start);
  const endTime = end === undefined ? undefined : parseDateTime(end);
  for (const [field, value, time] of [
    ['start', start, startTime],
    ['end', end, endTime],
  ] as const) {
    if (value !== undefined && time === undefined) {
      return `${field} "${value}" is not a valid ISO 8601 date-time with seconds and an offset (e.g., "2026-11-10T00:00:00Z"), or names a date that does not exist.`;
    }
  }
  if (startTime && endTime && startTime.epochMs > endTime.epochMs) {
    return `start "${start}" is after end "${end}"; the window would hold no messages.`;
  }
  return;
}

/**
 * Whether normalized filters pass every check the handler applies to the filter
 * inputs: one location filter at most, a valid area, point, and zone, and a valid
 * window.
 */
function passesFilterChecks(filters: SearchFilters): boolean {
  return (
    locationFiltersSet(filters).length <= 1 &&
    (filters.area === undefined || VALID_AREA_CODES.has(filters.area)) &&
    (filters.point === undefined || isValidPoint(filters.point)) &&
    (filters.zone === undefined || isValidZone(filters.zone)) &&
    timeWindowProblem(filters) === undefined
  );
}

/** The ID prefix every CAP alert message shares, which a keyset leaves out. */
const CAP_ID_PREFIX = 'urn:oid:2.49.0.1.840.0.';

/** A CAP message ID: the shared prefix, the 40-hex message hash, then `segment.version`. */
const CAP_ID_PATTERN = /^urn:oid:2\.49\.0\.1\.840\.0\.([0-9a-f]{40})\.(\d{3}\.\d+)$/;

/**
 * Message IDs as a keyset carries them: grouped by message hash, each group
 * `[hash, ...segment.version]`, because one product issues dozens of segments at
 * one instant and a group spells its hash once. An ID of any other shape (a test
 * heartbeat) is a group of its own, `[id]`.
 */
function compactIds(ids: Iterable<string>): string[][] {
  const groups = new Map<string, string[]>();
  const loose: string[][] = [];
  for (const id of ids) {
    const [, hash, suffix] = CAP_ID_PATTERN.exec(id) ?? [];
    if (hash === undefined || suffix === undefined) {
      loose.push([id]);
      continue;
    }
    const group = groups.get(hash);
    if (group) group.push(suffix);
    else groups.set(hash, [hash, suffix]);
  }
  return [...groups.values(), ...loose];
}

/** The message IDs a keyset's groups spell out. */
function expandIds(groups: readonly (readonly [string, ...string[]])[]): Set<string> {
  const ids = new Set<string>();
  for (const [head, ...suffixes] of groups) {
    if (suffixes.length === 0) ids.add(head);
    for (const suffix of suffixes) ids.add(`${CAP_ID_PREFIX}${head}.${suffix}`);
  }
  return ids;
}

/** An instant as a compact canonical UTC date-time, for a keyset boundary. */
function utcDateTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('.000Z', 'Z');
}

/**
 * The shape of a keyset as decoded. Message IDs only ever drop rows from a
 * response, so beyond their count and grouping nothing about them is checked.
 */
const keysetSchema = z
  .object({
    sent: z.string(),
    ids: z.array(z.tuple([z.string()], z.string())).min(1),
  })
  .strict();

/**
 * Where a windowed walk resumes: the `sent` instant the previous page ended at, and
 * the messages already returned at that instant. NWS orders a window newest first
 * by `sent` alone and reorders messages that share an instant from one request to
 * the next, so a position inside a tie has to be the set of IDs already returned.
 */
interface Keyset {
  /** Message IDs already returned at `sent`. */
  readonly seen: ReadonlySet<string>;
  /** The boundary instant, canonical. */
  readonly sent: string;
  readonly sentMs: number;
}

/**
 * Where a continued page resumes. A token this tool mints carries the normalized
 * filters of the query that minted it; a token from before the query was carried
 * (`{ offset, limit }` alone) has no `filters` and resumes against the filters
 * sent with it. A windowed search's token also carries its keyset, and its
 * `offset` is unused.
 */
interface Continuation {
  filters?: SearchFilters | undefined;
  keyset?: Keyset | undefined;
  limit: number;
  offset: number;
}

const INVALID_CURSOR_HINT =
  'Omit cursor and send the filters to start from the first page, or pass the nextCursor from the previous response unchanged.';

/**
 * Decode a continuation token before any request. Fails as InvalidParams
 * (`invalid_cursor`) for a token that does not decode, carries a non-integer
 * offset or limit, or carries filters that fail the input schema or the checks
 * the filter inputs get — and for a pairing no walk could have minted: an offset
 * token sent with `start` or `end` (`inputsWindowed`) or carrying a window, a
 * keyset without a window, or a keyset outside its window or past what one
 * `/alerts` request can page through.
 */
function readCursor(cursor: string, inputsWindowed: boolean, ctx: Context): Continuation {
  const { offset, limit, filters, keyset } = decodeCursor(cursor, ctx);
  validatePageWindow(offset, limit, cursor, INVALID_CURSOR_HINT);
  const invalid = () => invalidCursor(cursor, INVALID_CURSOR_HINT);

  let carried: SearchFilters | undefined;
  if (filters !== undefined) {
    const parsed = carriedFiltersSchema.safeParse(filters);
    if (!parsed.success) throw invalid();
    carried = normalizeFilters(parsed.data);
    if (!passesFilterChecks(carried)) throw invalid();
  }

  if (keyset === undefined) {
    // An offset token pages the active alerts; no window walk mints one.
    if (inputsWindowed || (carried && isWindowed(carried))) throw invalid();
    return { offset, limit, filters: carried };
  }

  if (!carried || !isWindowed(carried)) throw invalid();
  const parsedKeyset = keysetSchema.safeParse(keyset);
  if (!parsedKeyset.success) throw invalid();
  const sent = parseDateTime(parsedKeyset.data.sent);
  const startMs = carried.start === undefined ? undefined : parseDateTime(carried.start)?.epochMs;
  const endMs = carried.end === undefined ? undefined : parseDateTime(carried.end)?.epochMs;
  const seen = expandIds(parsedKeyset.data.ids);
  if (
    sent === undefined ||
    (startMs !== undefined && sent.epochMs < startMs) ||
    (endMs !== undefined && sent.epochMs > endMs) ||
    seen.size + Math.min(limit, MAX_ALERTS) + 1 > MAX_UPSTREAM_LIMIT
  ) {
    throw invalid();
  }
  return {
    offset,
    limit,
    filters: carried,
    keyset: { sent: sent.text, sentMs: sent.epochMs, seen },
  };
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
  message_type: blankAsUnset(z.enum(['Alert', 'Update', 'Cancel']).optional()).describe(
    'Filter by CAP message type: "Alert" for an original issuance, "Update" for a revision of an earlier message, "Cancel" for a cancellation. Applies to active and windowed searches alike.',
  ),
  status: blankAsUnset(
    z.enum(['Actual', 'Exercise', 'System', 'Test', 'Draft']).default('Actual'),
  ).describe(
    'Alert status filter. Default "Actual". Use a different value only when you specifically need non-live alerts.',
  ),
  start: z
    .string()
    .optional()
    .meta({ pattern: DATE_TIME_INPUT_PATTERN.source })
    .describe(
      'Search the alert messages issued at or after this time instead of the alerts active now, as an ISO 8601 date-time with seconds and an offset (e.g., "2026-11-10T00:00:00Z" or "2026-11-09T18:00:00-06:00"). The window bounds when each message was sent, inclusive at both ends, not when its hazard was in effect: a warning issued before start is missed even while it was still in effect. A windowed search returns every message issued in the window, updates and cancellations included. NWS keeps alert messages for 7 days. Combines with every filter; omit start and end to search active alerts.',
    ),
  end: z
    .string()
    .optional()
    .meta({ pattern: DATE_TIME_INPUT_PATTERN.source })
    .describe(
      'Latest issuance time to include (inclusive), in the same format as start. On its own it searches every message NWS still keeps that was issued at or before it; equal to start, it searches that one instant. Omit start and end to search active alerts.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .default(MAX_ALERTS)
    .describe(
      `Maximum number of alerts to include in this page (default ${MAX_ALERTS}). A page holds at most ${MAX_ALERTS}; a larger limit is served as ${MAX_ALERTS} and reported through requestedLimit and effectiveLimit. On an active search totalCount still reports the full number of distinct matches, so a small limit returns a digest of broad or national searches without dropping the total; pass the returned nextCursor as cursor to reach the rest.`,
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque continuation token from a previous response's nextCursor; send it on its own. Omit for the first page. It carries that query's filters, window, and page size, so the filter inputs, start, end, and limit apply to the first page only. An active search re-fetches the active-alert feed on every call, so alerts are contiguous within one response but not across calls — the active set changes continuously as alerts are issued and expire, so a continued page covers the collection as it stands at that moment. A windowed search continues from the oldest message already returned, so its pages neither repeat nor skip a message.",
    ),
});

/**
 * The filter fields of the input — the window included — which a continuation
 * token carries. Strict, as the input is: a carried key that is not a filter is
 * refused, not stripped.
 */
const carriedFiltersSchema = searchAlertsInputSchema.omit({ limit: true, cursor: true }).strict();

type SearchFilters = z.infer<typeof carriedFiltersSchema>;

/** A window in words, for a heading or an empty result. */
function describeWindow(window: { end?: string | undefined; start?: string | undefined }): string {
  const start = window.start && escapeMarkdownInline(window.start);
  const end = window.end && escapeMarkdownInline(window.end);
  if (start && end) return `between ${start} and ${end}`;
  if (start) return `since ${start}`;
  return `at or before ${end}`;
}

/** What one page of a search hands back to the handler. */
interface SearchPage {
  readonly alerts: readonly Alert[];
  readonly nextCursor?: string | undefined;
  /** The page's own notice, composed after the limit clamp. */
  readonly notice?: string | undefined;
  /** Distinct matches before the page window; an active search's only. */
  readonly totalCount?: number | undefined;
}

/**
 * One page of the alerts active now. The service fetches and filters the whole
 * active collection — `/alerts/active` takes no upstream limit or cursor — and
 * the page is a window over that array, so continuation is local to one fetch.
 */
async function activePage(
  filters: SearchFilters,
  continuation: Continuation | undefined,
  limit: number,
  ctx: Context,
): Promise<SearchPage> {
  // The service collapses upstream duplicates on id (issue #36), so this is a
  // distinct-alert count, which is what `totalCount` reports.
  const result = await getNwsService().searchAlerts(filters, ctx);
  const total = result.alerts.length;
  const appliedFilters = describeFilters(filters);
  const offset = continuation?.offset ?? 0;
  const alerts = result.alerts.slice(offset, offset + limit);
  const nextCursor =
    offset + limit < total ? encodeCursor({ offset: offset + limit, limit, filters }) : undefined;

  let notice: string | undefined;
  if (total === 0) {
    notice = `No active alerts matched: ${appliedFilters}. Try a broader area, remove severity or event filters, or use nws_list_alert_types to verify event names.`;
  } else if (nextCursor) {
    notice = `Returning ${alerts.length} of ${total} matching alerts. Pass nextCursor back as cursor for the next page. Alerts are contiguous within this response only — every call re-fetches the active-alert feed, so a continued page covers the collection as it stands at that moment, and alerts issued or expired in between can shift entries across the page boundary. Duplicate alerts are collapsed on id within each fetch, so the same id arriving on two pages means the active set moved between calls, not that one alert was returned twice.`;
  } else if (continuation && alerts.length === 0) {
    const restart =
      appliedFilters === NATIONAL_SEARCH
        ? `Call again with limit ${limit} and no cursor to restart from the first match.`
        : `To restart from the first match, call again with those filters, limit ${limit}, and no cursor.`;
    notice = `The cursor points past the end of the ${total} alerts matching: ${appliedFilters}. ${restart}`;
  }
  return { alerts, totalCount: total, nextCursor, notice };
}

/**
 * One page of the alert messages issued in a window, newest first, walked with a
 * keyset this tool mints — never NWS's own cursor, which drops messages that share
 * a `sent` instant. A continued page asks for messages sent at or before the
 * boundary instant (`end` is inclusive), as many as were already returned there
 * plus a page plus one, and drops the ones already returned: whatever is left
 * holds the page, and one message more only when more remain. The response is the
 * newest messages at or before the boundary, so it holds the whole tie whenever
 * the tie is smaller than the request, and otherwise more unseen tie members than
 * a page; either way the extra message is exact.
 */
async function windowPage(
  filters: SearchFilters,
  keyset: Keyset | undefined,
  limit: number,
  ctx: Context,
): Promise<SearchPage> {
  const service = getNwsService();
  const appliedFilters = describeFilters(filters);
  // Rounded up to the second, so the cutoff a notice names is the one the check uses.
  const cutoffMs = Math.ceil((Date.now() - RETENTION_MS) / 1000) * 1000;
  const cutoff = utcDateTime(cutoffMs);
  const startMs = filters.start === undefined ? undefined : parseDateTime(filters.start)?.epochMs;
  // Only a window that reaches past the cutoff loses messages silently: NWS
  // returns what it still keeps, with no sign the rest is gone.
  const retention =
    startMs !== undefined && startMs < cutoffMs
      ? `This window starts before ${cutoff}, about as far back as NWS keeps alert messages (7 days), so messages issued before then may be missing from it.`
      : undefined;
  const keptSince = retention ? '' : ` NWS keeps alert messages for 7 days, back to ${cutoff}.`;

  // `/alerts` matches an event by its exact name, so each term resolves to the
  // type names it matches in part. A term that matches none must not reach NWS
  // as an empty filter, which would widen the search to every message.
  const eventTypes = filters.event && (await service.matchAlertEventTypes(filters.event, ctx));
  if (eventTypes?.length === 0) {
    return {
      alerts: [],
      notice: composeNotice(
        retention,
        `No NWS alert event type matches event=${filters.event?.join(', ')}, so no message can match. Use nws_list_alert_types to find valid event names.`,
      ),
    };
  }

  const seen = keyset?.seen ?? new Set<string>();
  const result = await service.searchAlertWindow(
    {
      ...filters,
      event: eventTypes,
      end: keyset?.sent ?? filters.end,
      limit: seen.size + limit + 1,
    },
    ctx,
  );
  const unseen = result.alerts.filter((alert) => !seen.has(alert.id));
  const alerts = unseen.slice(0, limit);
  const last = unseen.length > limit ? alerts.at(-1) : undefined;

  let nextCursor: string | undefined;
  let pageNotice: string | undefined;
  if (last) {
    const boundaryMs = Date.parse(last.sent);
    const boundary = utcDateTime(boundaryMs);
    const atBoundary = alerts
      .filter((alert) => Date.parse(alert.sent) === boundaryMs)
      .map((alert) => alert.id);
    // Offsets differ across offices, so ties compare by instant, never by string.
    const carried = keyset?.sentMs === boundaryMs ? [...seen, ...atBoundary] : atBoundary;
    if (carried.length + limit + 1 <= MAX_UPSTREAM_LIMIT) {
      nextCursor = encodeCursor({
        offset: 0,
        limit,
        filters,
        keyset: { sent: boundary, ids: compactIds(carried) },
      });
      pageNotice = `Returning ${alerts.length} alert messages, newest first; older messages in this window remain. Pass nextCursor back as cursor for the next page, which picks up where this one ends; a walk returns each message once.`;
    } else {
      pageNotice = `Returning ${alerts.length} alert messages, newest first. More remain, but this walk has already returned ${carried.length} issued at ${boundary}, more than one NWS request can page past; narrow the filters, or move end to just before ${boundary}, to reach the rest.`;
    }
  } else if (alerts.length === 0) {
    pageNotice = keyset
      ? `No alert messages remain past the previous page for: ${appliedFilters}. NWS keeps alert messages for 7 days, back to ${cutoff}; any that aged out since that page are gone.`
      : `No alert messages matched: ${appliedFilters}.${keptSince} Widen the window or remove filters, or omit start and end to search the alerts active now.`;
  }
  return { alerts, nextCursor, notice: composeNotice(retention, pageNotice) };
}

export const searchAlertsTool = tool('nws_search_alerts', {
  description:
    'Search weather alerts (watches, warnings, advisories) across the US: the alerts active now, or — with start and/or end — every alert message issued in that window within the last 7 days, updates and cancellations included, to answer whether a place was under a warning at a past time. Filter by state, coordinates, zone, land/marine region, event type, severity, urgency, certainty, or message type. area, point, zone, region_type, and region are mutually exclusive — provide at most one. Omit all filters for a national search.',
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
    {
      reason: 'invalid_time_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start or end is not a valid ISO 8601 date-time with seconds and an offset, or start is after end',
      recovery:
        'Pass start and end as ISO 8601 date-times with seconds and an offset (e.g., "2026-11-10T00:00:00Z" or "2026-11-09T18:00:00-06:00") with start no later than end, or omit both to search the alerts active now.',
      severity: 'notice',
    },
  ],

  input: searchAlertsInputSchema,

  output: z.object({
    alerts: z
      .array(alertOutputSchema)
      .describe(
        `Matching alerts for this page — on a windowed search, the alert messages issued in the window, newest first (at most the applied limit, which never exceeds ${MAX_ALERTS})`,
      ),
    window: z
      .object({
        start: z.string().optional().describe('Earliest issuance time searched (inclusive)'),
        end: z.string().optional().describe('Latest issuance time searched (inclusive)'),
      })
      .optional()
      .describe(
        'The issuance window a windowed search covered, as sent to NWS; absent on a search of the alerts active now',
      ),
  }),

  // Result-set context the agent reasons with — counts, applied filters echo, and empty-result
  // guidance. Populated via ctx.enrich(...) so it reaches structuredContent and content[] alike;
  // kept out of the domain return.
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total distinct alerts matching the filters in this fetch, before the page window is applied. NWS repeats some alerts verbatim within one response; the copies are collapsed on id, so this counts each alert once. Compare against shown to tell whether matches were withheld from this page. Reported on every search of the active alerts; absent on a windowed search, for which NWS gives no total.',
      ),
    shown: z.number().describe('Number of alerts included in this response'),
    appliedFilters: z
      .string()
      .describe('Summary of applied search filters, the start and end of a window included'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        "Opaque token for the next page of matches — pass it back as `cursor` on its own; it carries this query's filters, window, and page size. Omitted when this is the last page.",
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
        'Guidance when the requested limit exceeded the page cap, when no alerts matched (echoes applied filters and suggests how to broaden), when matches remain beyond this page, when the supplied cursor points past the end of the match set, or when a window starts before the 7 days NWS keeps alert messages for.',
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
    // Blanks are unset from here on, so only filters that carry a value count
    // toward mutual exclusion and reach the shape checks below (issue #46).
    const inputFilters = normalizeFilters(input);
    const continuation =
      cursor === undefined ? undefined : readCursor(cursor, isWindowed(inputFilters), ctx);
    const filters = continuation?.filters ?? inputFilters;

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

    const windowProblem = timeWindowProblem(filters);
    if (windowProblem) {
      throw ctx.fail(
        'invalid_time_window',
        windowProblem,
        { start: filters.start, end: filters.end },
        { literals: ['start', 'end'] },
      );
    }

    // The cursor carries its own page size, held to the cap; a first page holds
    // `limit` to the cap and discloses the clamp.
    const { effectiveLimit, clamp }: PageLimit = continuation
      ? { effectiveLimit: Math.min(continuation.limit, MAX_ALERTS) }
      : clampPageLimit(input.limit, MAX_ALERTS);
    const windowed = isWindowed(filters);
    const page = windowed
      ? await windowPage(filters, continuation?.keyset, effectiveLimit, ctx)
      : await activePage(filters, continuation, effectiveLimit, ctx);
    const appliedFilters = describeFilters(filters);

    ctx.log.info('Alerts search completed', {
      windowed,
      total: page.totalCount,
      shown: page.alerts.length,
      appliedFilters,
    });

    ctx.enrich({
      ...(page.totalCount === undefined ? {} : { totalCount: page.totalCount }),
      shown: page.alerts.length,
      appliedFilters,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...clamp?.fields,
    });
    const notice = composeNotice(clamp?.notice, page.notice);
    if (notice) ctx.enrich.notice(notice);

    return {
      alerts: page.alerts.map(toAlertOutput),
      ...(windowed
        ? {
            window: {
              ...(filters.start ? { start: filters.start } : {}),
              ...(filters.end ? { end: filters.end } : {}),
            },
          }
        : {}),
    };
  },

  format: (result) => {
    const { alerts, window } = result;
    if (alerts.length === 0) {
      return [
        {
          type: 'text',
          text: window
            ? `No alert messages issued ${describeWindow(window)} matched. See the enrichment block below for filters and recovery guidance.`
            : 'No active alerts matched. See the enrichment block below for filters and recovery guidance.',
        },
      ];
    }

    const plural = alerts.length === 1 ? '' : 's';
    const lines = [
      window
        ? `## ${alerts.length} Alert Message${plural} Issued ${describeWindow(window)}\n`
        : `## ${alerts.length} Active Alert${plural}\n`,
    ];

    for (const alert of alerts) {
      lines.push(...alertMarkdownLines(alert), '', '---', '');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
