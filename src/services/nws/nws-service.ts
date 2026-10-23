/**
 * @fileoverview NWS API client service. Handles HTTP requests, /points resolution
 * with caching, and retry logic for transient failures.
 * @module services/nws/nws-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  McpError,
  notFound,
  requestCancelled,
  serializationError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  httpErrorFromResponse,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { interiorPoint } from './interior-point.js';
import type {
  AffectedZone,
  Alert,
  AlertCounts,
  AlertHazard,
  AlertReference,
  ForecastPeriod,
  ForecastResponse,
  NwsValue,
  Observation,
  PointsMetadata,
  ProductListEntry,
  Station,
  ZoneForecastPeriod,
} from './types.js';
import { ALERT_HAZARD_KEYS } from './types.js';

const BASE_URL = 'https://api.weather.gov';
const POINTS_CACHE_TTL_MS = 3_600_000; // 1 hour — grid cells rarely change
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Instance-scoped cache for /points metadata. Grid cells are geography, not tenant-scoped. */
const pointsCache = new Map<string, { data: PointsMetadata; expires: number }>();

/** Extract the last path segment from an NWS API URL (e.g., zone code from zone URL). */
function extractZoneCode(url: string): string {
  const lastSlash = url.lastIndexOf('/');
  return lastSlash >= 0 ? url.slice(lastSlash + 1) : url;
}

/**
 * NWS zone URL shape: `.../zones/{type}/{code}`. Callers of single-zone fields
 * (`forecastZone`, `county`) already know the type from the field name, but an
 * alert's `affectedZones` mixes forecast, county, and fire zones in one array,
 * so the type segment has to survive extraction there.
 */
const ZONE_URL_PATTERN = /\/zones\/([^/]+)\/([^/]+)\/?$/;

/** Split an alert zone URL into its code and NWS zone type. */
function parseAffectedZone(url: string): AffectedZone {
  const [, type, code] = ZONE_URL_PATTERN.exec(url) ?? [];
  // Not a zone URL — keep the value as the code and report the type as unknown
  // rather than guessing one the caller might act on.
  if (!type || !code) return { code: extractZoneCode(url), type: 'unknown' };
  return { code, type };
}

/** Truncate coordinate to 4 decimal places per NWS API requirement. */
function truncateCoord(n: number): number {
  return Math.trunc(n * 10000) / 10000;
}

/** Build cache key for /points resolution. */
function pointsCacheKey(lat: number, lon: number): string {
  return `nws/points/${truncateCoord(lat)}_${truncateCoord(lon)}`;
}

const DEFAULT_NOT_FOUND = 'Requested NWS resource not found.';
const POINTS_NOT_FOUND =
  'NWS only covers the US. Provide coordinates within US states or territories.';
const CANCELLED_MESSAGE = 'NWS API request cancelled — the caller disconnected.';

/**
 * Problem type NWS returns (HTTP 404) for a marine gridpoint forecast and for an
 * offshore marine zone's text forecast. A coastal marine zone without a text
 * forecast answers a generic `NotFound` instead; many coastal zones serve one.
 */
const MARINE_FORECAST_NOT_SUPPORTED = 'MarineForecastNotSupported';

/** Zone record `properties.type` values that mark a marine forecast zone; land zones are `public`. */
const MARINE_ZONE_TYPES: ReadonlySet<unknown> = new Set(['coastal', 'offshore']);

/**
 * Every NWS zone, station, and office ID is a plain alphanumeric token. A caller ID
 * that is not one fails as the tool's not-found reason without a request: a "/" or
 * "%" would reach another endpoint or be refused by the upstream edge, and a "." or
 * ".." segment resolves onto the parent path even when percent-encoded.
 */
const PATH_ID_PATTERN = /^[A-Za-z0-9]+$/;

/**
 * The two alert-ID shapes NWS emits: a CAP message identifier (a 40-hex message
 * hash, a 3-digit segment, and a version) and the `-KEEPALIVE-` heartbeat it lists
 * among active alerts with status Test. Case-sensitive, as NWS is — it answers an
 * uppercased ID with 404. Anything else is rejected before a URL is built, which
 * also keeps "/", "%", and ".." segments off the request path.
 */
export const ALERT_ID_PATTERN =
  /^urn:oid:2\.49\.0\.1\.840\.0(?:\.[0-9a-f]{40}\.[0-9]{3}\.[0-9]+|-KEEPALIVE-[0-9]+)$/;

/**
 * Builds the error for a 404. `problemType` is the last segment of the NWS
 * problem document's `type` URI (e.g. `InvalidZone`), or undefined when the body
 * carries none — the call site decides which types it can tell apart.
 */
type NotFoundFactory = (message: string, problemType: string | undefined) => Error;

/**
 * The `marine_forecast_unsupported` failure `nws_get_forecast` and
 * `nws_get_zone_forecast` both declare: NWS serves no point forecast for marine
 * areas, and no zone text forecast for some marine zones. The framework fills the
 * recovery hint from the calling tool's contract entry for this reason.
 */
function marineForecastUnsupported(message: string, data: Record<string, unknown>): McpError {
  return notFound(message, { ...data, reason: 'marine_forecast_unsupported' });
}

/** The fields of an NWS RFC 7807 problem document a call site can key on. */
interface NwsProblem {
  /** Raw `detail` string, when the body has one. */
  readonly detail: string | undefined;
  /** Last path segment of the `type` URI (e.g. `InvalidParameter`), when the body has one. */
  readonly type: string | undefined;
}

/**
 * Builds the error for a 400 from the `ValidationError` `nwsFetch` raises by
 * default and the problem document it came from. The call site decides which
 * problems it can name a reason for and returns `error` for the rest.
 */
type BadRequestFactory = (error: McpError, problem: NwsProblem) => Error;

/** Read the `type` segment and `detail` of an NWS problem document; both undefined when absent. */
function parseProblem(text: string): NwsProblem {
  try {
    const body = JSON.parse(text) as { type?: unknown; detail?: unknown } | null;
    const type = typeof body?.type === 'string' ? body.type : '';
    return {
      type: type.slice(type.lastIndexOf('/') + 1) || undefined,
      detail: typeof body?.detail === 'string' ? body.detail : undefined,
    };
  } catch {
    return { type: undefined, detail: undefined };
  }
}

/** Return a cleaned message when an NWS field contains useful text. */
function normalizeNwsMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/** Try to extract a detail message from an NWS error response body. */
function parseNwsErrorDetail(text: string): string | null {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const parameterErrors = Array.isArray(body.parameterErrors)
      ? [
          ...new Set(
            body.parameterErrors
              .map((error) =>
                error && typeof error === 'object'
                  ? normalizeNwsMessage((error as Record<string, unknown>).message)
                  : null,
              )
              .filter((message): message is string => message != null),
          ),
        ]
      : [];
    if (parameterErrors.length > 0) return parameterErrors.join('; ');

    const detail = normalizeNwsMessage(body.detail);
    if (detail && detail !== 'Bad Request') return detail;

    const title = normalizeNwsMessage(body.title);
    if (title) return title;

    if (detail) return detail;
  } catch {
    /* not JSON — ignore */
  }
  return null;
}

/**
 * Narrows the framework's default retry predicate by one case, and defers to it
 * for everything else.
 *
 * `defaultIsTransient` treats any non-`McpError` throw as transient. Every NWS
 * failure path in this module raises an `McpError`, so a throw that is not one
 * is a programmer error here and fails fast rather than burning the retry
 * budget. `TypeError` is the exception: `fetch` raises it for a network-level
 * failure, which is exactly what a retry is for.
 *
 * Composing rather than re-implementing keeps the transient code set and the
 * `data.retryable: false` opt-out (how a 501 arrives) on the framework's side,
 * where they cannot drift out of step with it.
 */
function isRetryableNwsError(error: unknown): boolean {
  if (!(error instanceof McpError)) return error instanceof TypeError;
  return defaultIsTransient(error);
}

async function fetchNwsResponse(url: string, ctx: Context): Promise<Response> {
  const { userAgent } = getServerConfig();
  const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ctx.signal]);

  try {
    return await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/geo+json',
      },
      signal,
    });
  } catch (error) {
    /**
     * This path does not go through `fetchWithTimeout`, so the framework's own
     * abort classification never runs. A caller that went away is neither a
     * server failure nor a timeout: raising it as `RequestCancelled` keeps it
     * out of `withRetry` and answers the HTTP transport with 499.
     */
    if (ctx.signal.aborted) {
      throw requestCancelled(CANCELLED_MESSAGE, { url }, { cause: error });
    }

    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw timeout(
        `NWS API request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds. Retry in a few seconds.`,
        { url, timeoutMs: REQUEST_TIMEOUT_MS },
        { cause: error },
      );
    }

    throw error;
  }
}

function parseNwsJson<T>(text: string, url: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    // HTML body usually signals a transient CDN/edge intercept — keep retryable
    // (ServiceUnavailable). Anything else is a real serialization failure.
    const isHtml = /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
    if (isHtml) {
      throw serviceUnavailable(
        'NWS API returned HTML instead of JSON. Retry in a few seconds.',
        { url },
        { cause: error },
      );
    }
    throw serializationError('NWS API returned invalid JSON.', { url }, { cause: error });
  }
}

function createRetryContext(ctx: Context) {
  return requestContextService.createRequestContext({
    operation: 'nwsFetch',
    parentContext: {
      requestId: ctx.requestId,
      tenantId: ctx.tenantId,
      ...(ctx.auth ? { auth: ctx.auth } : {}),
    },
  });
}

/** Fetch JSON from the NWS API with User-Agent, timeout, and retries around the full pipeline. */
function nwsFetch<T>(
  url: string,
  ctx: Context,
  retries = MAX_RETRIES,
  notFoundMessage = DEFAULT_NOT_FOUND,
  notFoundFactory: NotFoundFactory = (message) => notFound(message),
  badRequestFactory: BadRequestFactory = (error) => error,
): Promise<T> {
  let attempts = 0;
  const retryContext = createRetryContext(ctx);

  return withRetry(
    async () => {
      attempts += 1;
      if (attempts > 1) {
        ctx.log.info('Retrying NWS request', { url, attempt: attempts - 1 });
      }

      const response = await fetchNwsResponse(url, ctx);
      const text = await response.text();

      if (response.ok) {
        return parseNwsJson<T>(text, url);
      }

      if (response.status === 404) {
        throw notFoundFactory(notFoundMessage, parseProblem(text).type);
      }

      // 400 carries an upstream parameter-validation message we want to surface
      // verbatim — our params were valid JSON-RPC, NWS rejected the semantics.
      if (response.status === 400) {
        const detail = parseNwsErrorDetail(text);
        throw badRequestFactory(
          validationError(detail ?? `NWS API returned 400: Bad Request for ${url}`, {
            url,
            status: response.status,
          }),
          parseProblem(text),
        );
      }

      // Body already consumed via `response.text()` above — captureBody: false
      // avoids the helper trying to read it again. The helper classifies the
      // whole 5xx range as ServiceUnavailable, which keeps NWS's well-known
      // transient 500s (especially grid forecast endpoints) retryable.
      throw await httpErrorFromResponse(response, {
        service: 'NWS',
        data: { url },
        captureBody: false,
      });
    },
    {
      maxRetries: retries,
      baseDelayMs: RETRY_DELAY_MS,
      maxDelayMs: RETRY_DELAY_MS * Math.max(retries, 1),
      jitter: 0,
      operation: 'nwsFetch',
      context: retryContext,
      signal: ctx.signal,
      isTransient: isRetryableNwsError,
    },
  ).catch((error) => {
    /**
     * `withRetry` rejects with the raw abort reason when the caller disconnects
     * during a backoff sleep, so the classification above is bypassed. Without
     * this the DOMException named `AbortError` reads as a `Timeout` downstream.
     */
    if (ctx.signal.aborted && !(error instanceof McpError)) {
      throw requestCancelled(CANCELLED_MESSAGE, { url }, { cause: error });
    }

    if (!isRetryableNwsError(error) || error instanceof McpError) {
      throw error;
    }

    throw serviceUnavailable(
      `NWS API unavailable after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
      { url, retryAttempts: attempts },
      { cause: error },
    );
  });
}

/**
 * Sharpens a point-keyed request's exhausted 500. NWS answers some open-ocean points
 * outside its marine zones with a 500 on every request, in the same generic problem
 * document as any unexpected failure, so one response cannot tell that apart from an
 * outage: the message names the point and `data.recovery.hint` gives both readings.
 * The baseline ServiceUnavailable and its `data` (status, url, retryAttempts) stay;
 * every other failure passes through.
 */
function explainPointServerError(error: unknown, request: string, seaAdvice: string): unknown {
  if (!(error instanceof McpError) || error.data?.status !== 500) return error;
  const attempts = error.data.retryAttempts;
  const tail = typeof attempts === 'number' ? ` (failed after ${attempts} attempts)` : '';
  return serviceUnavailable(
    `NWS returned HTTP 500 for ${request}${tail}.`,
    {
      ...error.data,
      recovery: {
        hint: `NWS answers some open-ocean points outside its marine zones with HTTP 500 on every request. ${seaAdvice} For a point on land, NWS is failing and a later retry may succeed.`,
      },
    },
    { cause: error },
  );
}

/**
 * NWS rejects a well-formed alert-search `point` outside its coverage with a 400
 * `InvalidParameter` problem whose detail names the parameter ("Parameter \"point\"
 * is invalid: out of bounds"). That one fails as `nws_search_alerts`' declared
 * `invalid_point` reason, whose recovery the framework fills; a 400 naming any
 * other parameter, or of another problem type, passes through unchanged.
 */
function pointOutsideCoverage(point: string): BadRequestFactory {
  return (error, problem) => {
    const namesPoint =
      problem.type === 'InvalidParameter' && problem.detail?.startsWith('Parameter "point" ');
    if (!namesPoint) return error;
    return validationError(
      `Point "${point}" is outside NWS coverage (NWS: ${error.message}).`,
      { ...error.data, reason: 'invalid_point' },
      { cause: error },
    );
  };
}

/** Resolve coordinates to NWS grid metadata, cached in-process. */
async function resolvePoints(lat: number, lon: number, ctx: Context): Promise<PointsMetadata> {
  const key = pointsCacheKey(lat, lon);
  const entry = pointsCache.get(key);
  if (entry && entry.expires > Date.now()) {
    ctx.log.debug('Points cache hit', { lat, lon });
    return entry.data;
  }

  const tLat = truncateCoord(lat);
  const tLon = truncateCoord(lon);
  ctx.log.info('Resolving /points', { lat: tLat, lon: tLon });

  const data = await nwsFetch<Record<string, unknown>>(
    `${BASE_URL}/points/${tLat},${tLon}`,
    ctx,
    MAX_RETRIES,
    POINTS_NOT_FOUND,
    (message) => validationError(message, { lat: tLat, lon: tLon, reason: 'out_of_scope' }),
  ).catch((error: unknown) => {
    throw explainPointServerError(
      error,
      `point (${tLat}, ${tLon})`,
      'For a point at sea, move it toward the US coast.',
    );
  });

  const props = data.properties as Record<string, unknown>;
  const relativeLocation = (props.relativeLocation as Record<string, unknown>)
    ?.properties as Record<string, string>;

  const forecastUrl = props.forecast as string | undefined;
  const forecastHourlyUrl = props.forecastHourly as string | undefined;
  const observationStationsUrl = props.observationStations as string | undefined;
  const forecastZone = extractZoneCode((props.forecastZone as string) ?? '');

  /**
   * Beyond the forecast grid — offshore waters, and some remote land such as the
   * interior of the Northern Mariana Islands: a real answer, not a malformed response.
   */
  const gridless = !forecastUrl && !forecastHourlyUrl && !observationStationsUrl;
  if (gridless && (props.type === 'marine' || props.type === 'land')) {
    const metadata: PointsMetadata = {
      kind: props.type === 'marine' ? 'gridless_marine' : 'gridless_land',
      forecastZone,
    };
    pointsCache.set(key, { data: metadata, expires: Date.now() + POINTS_CACHE_TTL_MS });
    return metadata;
  }

  if (!forecastUrl || !forecastHourlyUrl || !observationStationsUrl) {
    throw serviceUnavailable('NWS /points response missing required URLs', {
      lat: tLat,
      lon: tLon,
      forecastUrl: !!forecastUrl,
      forecastHourlyUrl: !!forecastHourlyUrl,
      observationStationsUrl: !!observationStationsUrl,
    });
  }

  const metadata: PointsMetadata = {
    kind: 'gridded',
    office: props.gridId as string,
    gridX: props.gridX as number,
    gridY: props.gridY as number,
    forecastUrl,
    forecastHourlyUrl,
    observationStationsUrl,
    city: relativeLocation?.city ?? '',
    state: relativeLocation?.state ?? '',
    timeZone: props.timeZone as string,
    forecastZone,
    county: extractZoneCode((props.county as string) ?? ''),
  };

  pointsCache.set(key, { data: metadata, expires: Date.now() + POINTS_CACHE_TTL_MS });
  return metadata;
}

/** Parse forecast periods from a forecast GeoJSON response. */
function parseForecastPeriods(data: Record<string, unknown>): ForecastResponse {
  const props = data.properties as Record<string, unknown>;
  const rawPeriods = props.periods as Record<string, unknown>[];

  const periods: ForecastPeriod[] = rawPeriods.map((p) => ({
    number: p.number as number,
    name: p.name as string,
    startTime: p.startTime as string,
    endTime: p.endTime as string,
    isDaytime: p.isDaytime as boolean,
    temperature: p.temperature as number,
    temperatureUnit: p.temperatureUnit as string,
    windSpeed: p.windSpeed as string,
    windDirection: p.windDirection as string,
    shortForecast: p.shortForecast as string,
    detailedForecast: p.detailedForecast as string,
    probabilityOfPrecipitation: (p.probabilityOfPrecipitation as NwsValue) ?? {
      value: null,
      unitCode: 'wmoUnit:percent',
    },
    dewpoint: (p.dewpoint as NwsValue) ?? { value: null, unitCode: 'wmoUnit:degC' },
    relativeHumidity: (p.relativeHumidity as NwsValue) ?? {
      value: null,
      unitCode: 'wmoUnit:percent',
    },
  }));

  return {
    generatedAt: props.generatedAt as string,
    updateTime: (props.updateTime as string | undefined) ?? null,
    periods,
  };
}

/**
 * NWS lists an update's references in no fixed order. Sort them newest first by
 * the parsed `sent` instant — offsets differ across a DST change, so the strings
 * do not compare. References sent at the same instant keep upstream order (the
 * sort is stable), and one whose `sent` does not parse sorts after every
 * parseable one, kept verbatim.
 */
function newestReferencesFirst(references: AlertReference[]): AlertReference[] {
  return references
    .map((reference) => ({ reference, instant: Date.parse(reference.sent) }))
    .sort((a, b) => {
      if (Number.isNaN(a.instant)) return Number.isNaN(b.instant) ? 0 : 1;
      if (Number.isNaN(b.instant)) return -1;
      return b.instant - a.instant;
    })
    .map(({ reference }) => reference);
}

/**
 * A WMO abbreviated heading — `TTAAii CCCC YYGGgg`, then an optional `BBB`
 * amendment group (`WWUS85 KRIW 230445`, `WGUS75 KTWC 230254 RRA`) — capturing the
 * issuing centre. Anchored, fixed-width groups over a one-line field.
 */
const WMO_HEADING_PATTERN = /^[A-Z]{4}\d{2} ([A-Z]{4}) \d{6}(?: [A-Z]{3})?$/;

/**
 * Issuing centres whose office code is not the centre minus its leading letter:
 * San Juan's and Pago Pago's AFD locations are SJU and PPG, and the tsunami
 * warning centres and the national test-message centre have no office
 * discussion at all.
 */
const CENTRE_OFFICE_EXCEPTIONS = new Map<string, string | null>([
  ['TJSJ', 'SJU'],
  ['NSTU', 'PPG'],
  ['PAAQ', null],
  ['PHEB', null],
  ['KWBC', null],
]);

/**
 * Element 0 of a CAP parameter. NWS sends every parameter as an array of strings;
 * anything else reads as not sent.
 */
function firstParameter(value: unknown): string | undefined {
  const [first] = Array.isArray(value) ? value : [];
  return typeof first === 'string' ? first : undefined;
}

/**
 * The office code an alert names in its WMO header's issuing centre (`KRIW` →
 * `RIW`). The AWIPS identifier's suffix is a product location code, not the
 * office (`CWFALU` is Anchorage's), so it is never consulted.
 */
function officeFromWmoHeading(heading: string | undefined): string | null {
  const centre = heading === undefined ? undefined : WMO_HEADING_PATTERN.exec(heading)?.[1];
  if (centre === undefined) return null;
  const exception = CENTRE_OFFICE_EXCEPTIONS.get(centre);
  return exception === undefined ? centre.slice(1) : exception;
}

/** The hazard tags among an alert's CAP parameters, or null when NWS sent none. */
function parseHazard(parameters: Record<string, unknown>): AlertHazard | null {
  const hazard: { -readonly [K in keyof AlertHazard]: AlertHazard[K] } = {};
  for (const key of ALERT_HAZARD_KEYS) {
    const value = firstParameter(parameters[key]);
    if (value !== undefined) hazard[key] = value;
  }
  return Object.keys(hazard).length > 0 ? hazard : null;
}

/** Parse a single alert from GeoJSON feature. */
function parseAlert(feature: Record<string, unknown>): Alert {
  const p = feature.properties as Record<string, unknown>;
  // NWS keys `parameters` by name, every value an array of strings; anything
  // else reads as no parameters.
  const parameters =
    typeof p.parameters === 'object' && p.parameters !== null && !Array.isArray(p.parameters)
      ? (p.parameters as Record<string, unknown>)
      : {};
  const vtec: unknown[] = Array.isArray(parameters.VTEC) ? parameters.VTEC : [];
  return {
    id: p.id as string,
    event: p.event as string,
    headline: (p.headline as string) ?? null,
    description: (p.description as string) ?? null,
    instruction: (p.instruction as string) ?? null,
    severity: p.severity as string,
    urgency: p.urgency as string,
    certainty: p.certainty as string,
    areaDesc: p.areaDesc as string,
    sent: p.sent as string,
    effective: p.effective as string,
    onset: (p.onset as string) ?? null,
    ends: (p.ends as string) ?? null,
    expires: (p.expires as string) ?? null,
    status: p.status as string,
    messageType: p.messageType as string,
    // Compact each upstream CAP reference to the pair that identifies the prior
    // message, dropping its @id and sender.
    references: newestReferencesFirst(
      ((p.references as Record<string, unknown>[]) ?? []).map((r) => ({
        identifier: r.identifier as string,
        sent: r.sent as string,
      })),
    ),
    senderName: p.senderName as string,
    affectedZones: ((p.affectedZones as string[]) ?? []).map(parseAffectedZone),
    office: officeFromWmoHeading(firstParameter(parameters.WMOidentifier)),
    vtec: vtec.filter((entry): entry is string => typeof entry === 'string'),
    nwsHeadline: firstParameter(parameters.NWSheadline) ?? null,
    hazard: parseHazard(parameters),
  };
}

/** Parse observation from latest observation response. */
function parseObservation(
  data: Record<string, unknown>,
  stationId: string,
  stationName: string,
  timeZone: string | null,
): Observation {
  const props = data.properties as Record<string, unknown>;
  const nullValue: NwsValue = { value: null, unitCode: '' };

  return {
    stationId,
    stationName,
    timestamp: props.timestamp as string,
    textDescription: (props.textDescription as string) ?? '',
    timeZone,
    temperature: (props.temperature as NwsValue) ?? nullValue,
    dewpoint: (props.dewpoint as NwsValue) ?? nullValue,
    windSpeed: (props.windSpeed as NwsValue) ?? nullValue,
    windDirection: (props.windDirection as NwsValue) ?? nullValue,
    windGust: (props.windGust as NwsValue) ?? nullValue,
    barometricPressure: (props.barometricPressure as NwsValue) ?? nullValue,
    visibility: (props.visibility as NwsValue) ?? nullValue,
    relativeHumidity: (props.relativeHumidity as NwsValue) ?? nullValue,
    heatIndex: (props.heatIndex as NwsValue) ?? nullValue,
    windChill: (props.windChill as NwsValue) ?? nullValue,
    // Absent, not just null, on most 5-minute records.
    precipitationLastHour: (props.precipitationLastHour as NwsValue) ?? nullValue,
    precipitationLast3Hours: (props.precipitationLast3Hours as NwsValue) ?? nullValue,
    precipitationLast6Hours: (props.precipitationLast6Hours as NwsValue) ?? nullValue,
    cloudLayers: ((props.cloudLayers as Record<string, unknown>[]) ?? []).map((l) => ({
      base: (l.base as NwsValue) ?? nullValue,
      amount: (l.amount as string) ?? 'CLR',
    })),
  };
}

/**
 * A count map from /alerts/active/count. The spec types `areas` and `regions` as
 * objects keyed by code, and a map with no active alerts is empty; an empty map is
 * `{}` here whether it arrives as `{}`, as a bare `[]`, or not at all.
 */
function countMap(value: unknown): Readonly<Record<string, number>> {
  if (value == null || Array.isArray(value)) return {};
  return value as Record<string, number>;
}

/** Parse station features from observation stations response. */
function parseStations(data: Record<string, unknown>): Station[] {
  const features = (data.features ?? data.observationStations) as Record<string, unknown>[];
  if (!Array.isArray(features)) return [];

  return features.map((f) => {
    const p = f.properties as Record<string, unknown>;
    const geometry = f.geometry as Record<string, unknown>;
    const coords = (geometry?.coordinates as number[]) ?? [0, 0];

    return {
      stationId: (p.stationIdentifier as string) ?? '',
      name: (p.name as string) ?? '',
      elevation: (p.elevation as NwsValue) ?? { value: null, unitCode: '' },
      timeZone: (p.timeZone as string) ?? '',
      county: extractZoneCode((p.county as string) ?? ''),
      forecastZone: extractZoneCode((p.forecast as string) ?? ''),
      coordinates: [coords[0] ?? 0, coords[1] ?? 0] as const,
    };
  });
}

/** Haversine distance in kilometers between two lat/lon pairs. */
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Compass bearing from point 1 to point 2. */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Bearing degrees to compass direction. */
function bearingToCompass(deg: number): string {
  const dirs = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  return dirs[Math.round(deg / 22.5) % 16] ?? 'N';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ForecastResult {
  readonly forecast: ForecastResponse;
  readonly location: {
    city: string;
    state: string;
    office: string;
    timeZone: string;
    forecastZone: string;
    county: string;
  };
}

export interface AlertSearchResult {
  readonly alerts: readonly Alert[];
}

export interface ObservationResult {
  readonly observation: Observation;
}

export interface ObservationHistoryResult {
  /** Observations in the requested window, newest first, at most the requested count. */
  readonly observations: readonly Observation[];
  readonly stationId: string;
  readonly stationName: string;
  readonly timeZone: string | null;
}

export interface StationResult {
  readonly bearing: string;
  readonly county: string;
  readonly distance: number;
  readonly elevation: NwsValue;
  readonly forecastZone: string;
  readonly name: string;
  readonly stationId: string;
  readonly timeZone: string;
}

export interface FindStationsResult {
  /**
   * Every observation station the NWS grid cell reports, sorted nearest-first.
   * The upstream endpoint returns the collection in one response, so windowing
   * is a presentation concern the tool applies over this array — the service
   * hands back the complete set and never truncates it.
   */
  readonly stations: readonly StationResult[];
}

export interface OfficeDiscussionResult {
  readonly issuanceTime: string;
  readonly issuingOffice: string;
  readonly productCode: string;
  readonly productName: string;
  readonly productText: string;
  readonly wmoCollectiveId: string;
}

export interface ZoneForecastResult {
  readonly periods: readonly ZoneForecastPeriod[];
  readonly updated: string;
  readonly zoneId: string;
}

export class NwsService {
  /** Get forecast (standard or hourly) for coordinates. */
  async getForecast(
    lat: number,
    lon: number,
    hourly: boolean,
    ctx: Context,
  ): Promise<ForecastResult> {
    const points = await resolvePoints(lat, lon, ctx);
    const marineUnsupported = () =>
      marineForecastUnsupported(
        `Coordinates (${truncateCoord(lat)}, ${truncateCoord(lon)}) are in marine zone ${points.forecastZone}; NWS publishes no point forecast for marine areas.`,
        { latitude: lat, longitude: lon, forecastZone: points.forecastZone },
      );
    if (points.kind === 'gridless_marine') throw marineUnsupported();
    if (points.kind === 'gridless_land') {
      throw notFound(
        `Coordinates (${truncateCoord(lat)}, ${truncateCoord(lon)}) are in forecast zone ${points.forecastZone}, but NWS serves no forecast grid there and publishes no point forecast for them.`,
        {
          latitude: lat,
          longitude: lon,
          forecastZone: points.forecastZone,
          reason: 'no_forecast_grid',
        },
      );
    }

    const url = hourly ? points.forecastHourlyUrl : points.forecastUrl;
    ctx.log.info('Fetching forecast', { url, hourly });
    const data = await nwsFetch<Record<string, unknown>>(
      url,
      ctx,
      MAX_RETRIES,
      DEFAULT_NOT_FOUND,
      (message, problemType) =>
        problemType === MARINE_FORECAST_NOT_SUPPORTED ? marineUnsupported() : notFound(message),
    );

    return {
      location: {
        city: points.city,
        state: points.state,
        office: points.office,
        timeZone: points.timeZone,
        forecastZone: points.forecastZone,
        county: points.county,
      },
      forecast: parseForecastPeriods(data),
    };
  }

  /** Search active alerts with optional filters. */
  async searchAlerts(
    params: {
      area?: string | undefined;
      point?: string | undefined;
      zone?: string | undefined;
      region_type?: string | undefined;
      region?: string[] | undefined;
      event?: string[] | undefined;
      severity?: string[] | undefined;
      urgency?: string[] | undefined;
      certainty?: string[] | undefined;
      status?: string | undefined;
    },
    ctx: Context,
  ): Promise<AlertSearchResult> {
    const url = new URL(`${BASE_URL}/alerts/active`);

    if (params.area) url.searchParams.set('area', params.area);
    if (params.point) url.searchParams.set('point', params.point);
    if (params.zone) url.searchParams.set('zone', params.zone);
    // NWS accepts only the lowercase region_type values and only the uppercase
    // marine region codes; either casing mismatch is a 400 enumeration error.
    if (params.region_type) url.searchParams.set('region_type', params.region_type.toLowerCase());
    if (params.region?.length) url.searchParams.set('region', params.region.join(','));
    if (params.severity?.length) url.searchParams.set('severity', params.severity.join(','));
    if (params.urgency?.length) url.searchParams.set('urgency', params.urgency.join(','));
    if (params.certainty?.length) url.searchParams.set('certainty', params.certainty.join(','));
    const normalizedStatus = params.status?.trim().toLowerCase();
    if (normalizedStatus) url.searchParams.set('status', normalizedStatus);

    ctx.log.info('Searching alerts', { url: url.toString() });
    const data = await nwsFetch<Record<string, unknown>>(
      url.toString(),
      ctx,
      MAX_RETRIES,
      DEFAULT_NOT_FOUND,
      undefined,
      params.point ? pointOutsideCoverage(params.point) : undefined,
    ).catch((error: unknown) => {
      if (!params.point) throw error;
      throw explainPointServerError(
        error,
        `the alerts search at point "${params.point}"`,
        'For a point at sea, search by marine region (e.g., region "AT") or a marine area or zone filter instead.',
      );
    });

    const features = (data.features ?? []) as Record<string, unknown>[];
    const eventFilters = params.event
      ?.map((event) => event.trim().toLowerCase())
      .filter((event) => event.length > 0);

    // `/alerts/active` repeats some alerts verbatim within a single response —
    // byte-identical id, sent, event, and areaDesc — so the second copy carries
    // nothing the first did not. Collapse on id here, at the raw feature array,
    // rather than in the tool: this is ahead of both the event filter below and
    // the tool's page window, so no count is inflated and no duplicate can
    // straddle a page boundary (issue #36). Map insertion order keeps the first
    // occurrence in its upstream position.
    const byId = new Map<string, Alert>();
    for (const feature of features) {
      const alert = parseAlert(feature);
      if (!byId.has(alert.id)) byId.set(alert.id, alert);
    }

    const alerts = [...byId.values()].filter((alert) => {
      if (!eventFilters?.length) return true;
      const normalizedEvent = alert.event.toLowerCase();
      return eventFilters.some((event) => normalizedEvent.includes(event));
    });
    return { alerts };
  }

  /**
   * One alert message by ID, current or superseded. NWS answers `/alerts/{id}` with
   * a single GeoJSON Feature, parsed exactly as a search result is. A malformed ID
   * fails before any request, and NWS's 404 is the same `InvalidAlert` problem for
   * a fabricated ID and one past its ~7-day retention, so both are `alert_not_found`.
   */
  async getAlert(alertId: string, ctx: Context): Promise<Alert> {
    const id = alertId.trim();
    if (!ALERT_ID_PATTERN.test(id)) {
      throw notFound(
        'alert_id is not an NWS alert ID. NWS alert IDs read "urn:oid:2.49.0.1.840.0." followed by a 40-character lowercase hex hash, a 3-digit segment, and a version (e.g., "urn:oid:2.49.0.1.840.0.654087301e4bfcbe71d24494c26a965e54d3a1ad.001.1").',
        { reason: 'alert_not_found' },
      );
    }

    ctx.log.info('Fetching alert', { alertId: id });
    const feature = await nwsFetch<Record<string, unknown>>(
      `${BASE_URL}/alerts/${id}`,
      ctx,
      MAX_RETRIES,
      DEFAULT_NOT_FOUND,
      () =>
        notFound(
          `NWS has no alert "${id}": the ID does not exist, or the message is past the ~7 days NWS keeps alerts.`,
          { alertId: id, reason: 'alert_not_found' },
        ),
    );
    return parseAlert(feature);
  }

  /**
   * National active-alert counts, per area and per marine region. The endpoint
   * rejects every query parameter with a 400, so none is sent, and its `zones`
   * map (nearly all of the response, growing with the active set) is dropped.
   */
  async getAlertCounts(ctx: Context): Promise<AlertCounts> {
    ctx.log.info('Fetching active alert counts');
    const data = await nwsFetch<Record<string, unknown>>(`${BASE_URL}/alerts/active/count`, ctx);
    return {
      total: data.total as number,
      land: data.land as number,
      marine: data.marine as number,
      areas: countMap(data.areas),
      regions: countMap(data.regions),
    };
  }

  /** Get latest observation, either by station ID or by resolving nearest station from coordinates. */
  async getObservation(
    params: {
      latitude?: number | undefined;
      longitude?: number | undefined;
      stationId?: string | undefined;
    },
    ctx: Context,
  ): Promise<ObservationResult> {
    // Direct station ID — fetch metadata and observation in parallel
    if (params.stationId) {
      const stationId = params.stationId.toUpperCase();
      const notFoundMsg = `Station '${stationId}' not found.`;
      const stationNotFoundFactory: NotFoundFactory = (message) =>
        notFound(message, { stationId, reason: 'station_not_found' });

      // Separate factory for the observations/latest leg: a 404 there means the
      // station exists but has no current data — not a missing station ID.
      const noObservationsFactory: NotFoundFactory = (message) =>
        notFound(message, { stationId, reason: 'no_observations' });

      if (!PATH_ID_PATTERN.test(stationId)) throw stationNotFoundFactory(notFoundMsg, undefined);
      const stationPath = `${BASE_URL}/stations/${stationId}`;

      ctx.log.info('Fetching station metadata and latest observation', { stationId });
      const [stationResult, obsResult] = await Promise.allSettled([
        nwsFetch<Record<string, unknown>>(stationPath, ctx, 0, notFoundMsg, stationNotFoundFactory),
        nwsFetch<Record<string, unknown>>(
          `${stationPath}/observations/latest`,
          ctx,
          MAX_RETRIES,
          `Station '${stationId}' has no recent observations.`,
          noObservationsFactory,
        ),
      ]);

      // Station existence is the precondition: when the metadata leg fails,
      // surface that (station_not_found) even when the observations leg also
      // 404'd. Promise.all rejected with whichever 404 landed first, so the
      // observations leg's no_observations could mask a nonexistent station
      // (issue #19). allSettled lets us classify deterministically, station-first.
      if (stationResult.status === 'rejected') throw stationResult.reason;
      if (obsResult.status === 'rejected') throw obsResult.reason;

      const stationData = stationResult.value;
      const obsData = obsResult.value;

      const stationProps = stationData.properties as Record<string, unknown>;
      const stationName = (stationProps?.name as string) ?? stationId;
      const timeZone =
        typeof stationProps?.timeZone === 'string' ? (stationProps.timeZone as string) : null;
      const observation = parseObservation(obsData, stationId, stationName, timeZone);
      if (!observation.timestamp) {
        throw notFound(`Station ${stationId} has no recent observations.`, {
          stationId,
          reason: 'no_observations',
        });
      }
      return { observation };
    }

    // Coordinates — resolve nearest station, then fetch observation sequentially
    const lat = params.latitude as number;
    const lon = params.longitude as number;
    const points = await resolvePoints(lat, lon, ctx);
    // A point beyond the grid has no station list to follow — no stations nearby.
    const stations =
      points.kind === 'gridded' ? await this.fetchStations(points.observationStationsUrl, ctx) : [];
    const nearestStation = stations
      .map((station) => ({
        station,
        distance: haversine(lat, lon, station.coordinates[1], station.coordinates[0]),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.station;

    if (!nearestStation) {
      throw notFound('No observation stations found near this location.', {
        latitude: lat,
        longitude: lon,
        reason: 'no_stations_nearby',
      });
    }
    const stationId = nearestStation.stationId;
    const stationName = nearestStation.name;

    ctx.log.info('Fetching latest observation', { stationId });
    // NWS just listed this station, so a 404 here means it has no current data.
    const data = await nwsFetch<Record<string, unknown>>(
      `${BASE_URL}/stations/${stationId}/observations/latest`,
      ctx,
      MAX_RETRIES,
      `Station '${stationId}' has no recent observations.`,
      (message) => notFound(message, { stationId, reason: 'no_observations' }),
    );

    const observation = parseObservation(data, stationId, stationName, nearestStation.timeZone);
    if (!observation.timestamp) {
      throw notFound(`Station ${stationId} has no recent observations.`, {
        stationId,
        reason: 'no_observations',
      });
    }
    return { observation };
  }

  /**
   * Up to `limit` of a station's observations, newest first. `start` is
   * inclusive and `end` exclusive, and both must already be validated ISO 8601
   * date-times with seconds and an offset: NWS answers a date-only value with a
   * 400 and a calendar-invalid one (e.g. Feb 30) with a 500. The tool asks for
   * one past its page size, so the extra record tells it older observations
   * remain; paging policy stays with the caller.
   *
   * NWS answers an unknown station's observation list with HTTP 200 and an empty
   * collection, so only the station record's 404 tells a missing station from an
   * empty window. Both are fetched in parallel and classified station-first.
   */
  async getObservationHistory(
    params: {
      end?: string | undefined;
      limit: number;
      start?: string | undefined;
      stationId: string;
    },
    ctx: Context,
  ): Promise<ObservationHistoryResult> {
    const stationId = params.stationId.toUpperCase();
    const notFoundMsg = `Station '${stationId}' not found.`;
    const stationNotFoundFactory: NotFoundFactory = (message) =>
      notFound(message, { stationId, reason: 'station_not_found' });

    if (!PATH_ID_PATTERN.test(stationId)) throw stationNotFoundFactory(notFoundMsg, undefined);
    const stationPath = `${BASE_URL}/stations/${stationId}`;

    const observationsUrl = new URL(`${stationPath}/observations`);
    observationsUrl.searchParams.set('limit', String(params.limit));
    if (params.start) observationsUrl.searchParams.set('start', params.start);
    if (params.end) observationsUrl.searchParams.set('end', params.end);

    ctx.log.info('Fetching station metadata and observation history', {
      stationId,
      url: observationsUrl.toString(),
    });
    const [stationResult, obsResult] = await Promise.allSettled([
      nwsFetch<Record<string, unknown>>(stationPath, ctx, 0, notFoundMsg, stationNotFoundFactory),
      nwsFetch<Record<string, unknown>>(observationsUrl.toString(), ctx),
    ]);

    if (stationResult.status === 'rejected') throw stationResult.reason;
    if (obsResult.status === 'rejected') throw obsResult.reason;

    const stationProps = stationResult.value.properties as Record<string, unknown>;
    const stationName = (stationProps?.name as string) ?? stationId;
    const timeZone =
      typeof stationProps?.timeZone === 'string' ? (stationProps.timeZone as string) : null;
    const features = (obsResult.value.features ?? []) as Record<string, unknown>[];

    return {
      stationId,
      stationName,
      timeZone,
      observations: features.map((feature) =>
        parseObservation(feature, stationId, stationName, timeZone),
      ),
    };
  }

  /** Find every observation station near coordinates, sorted by proximity. */
  async findStations(lat: number, lon: number, ctx: Context): Promise<FindStationsResult> {
    const points = await resolvePoints(lat, lon, ctx);
    // A point beyond the grid has no station list to follow: an empty result, not an error.
    if (points.kind !== 'gridded') return { stations: [] };

    const found = await this.fetchStations(points.observationStationsUrl, ctx);
    const stations = found.map((s) => {
      const dist = haversine(lat, lon, s.coordinates[1], s.coordinates[0]);
      const bear = bearing(lat, lon, s.coordinates[1], s.coordinates[0]);
      return {
        stationId: s.stationId,
        name: s.name,
        distance: Math.round(dist * 10) / 10,
        bearing: bearingToCompass(bear),
        elevation: s.elevation,
        timeZone: s.timeZone,
        county: s.county,
        forecastZone: s.forecastZone,
      };
    });

    stations.sort((a, b) => a.distance - b.distance);

    return { stations };
  }

  /** Fetch and parse a grid cell's observation-station list. */
  private async fetchStations(url: string, ctx: Context): Promise<Station[]> {
    ctx.log.info('Fetching stations', { url });
    return parseStations(await nwsFetch<Record<string, unknown>>(url, ctx, MAX_RETRIES));
  }

  /** List all valid alert event type names. */
  async listAlertTypes(ctx: Context): Promise<readonly string[]> {
    ctx.log.info('Fetching alert types');
    const data = await nwsFetch<Record<string, unknown>>(
      `${BASE_URL}/alerts/types`,
      ctx,
      MAX_RETRIES,
    );
    return (data.eventTypes as string[]) ?? [];
  }

  /**
   * Get the latest narrative product (e.g., AFD, HWO) from a Weather Forecast Office.
   * Two-hop: (1) list products for office/type — newest first; (2) fetch full product by ID.
   * An empty @graph is ambiguous — both an unknown office and a valid office with no
   * current product of that type return HTTP 200 with `{"@graph":[]}`. When it's empty,
   * probe /offices/{officeId} (200 = valid, no product; 404 = unknown office) to branch
   * the error message. Episodic types (SPS, HWO) are commonly empty for valid offices;
   * routine types (AFD, ZFP) are empty when the office files them under another location
   * code (Anchorage's ZFP lives under AER and ALU, not AFC). FWF is filed only under WFO
   * codes, so an empty FWF list means the office issues none (e.g., AFC).
   */
  async getOfficeDiscussion(
    office: string,
    productType: string,
    ctx: Context,
  ): Promise<OfficeDiscussionResult> {
    const unknownOffice = () =>
      notFound(
        `No ${productType} products found for office "${office}". Verify the 3-letter WFO code (e.g., "SEW" for Seattle). The office code is the "location.office" field of nws_get_forecast output.`,
        {
          office,
          productType,
          reason: 'no_products',
          recovery: {
            hint: `Use nws_get_forecast with coordinates to find the office code (the "office" field in the location object), then retry with that value.`,
          },
        },
      );
    // `productType` is already constrained to an enum by the tool schema.
    if (!PATH_ID_PATTERN.test(office)) throw unknownOffice();

    const listUrl = `${BASE_URL}/products/types/${productType}/locations/${office}`;
    ctx.log.info('Fetching product list', { office, productType });

    const listData = await nwsFetch<Record<string, unknown>>(listUrl, ctx, MAX_RETRIES);
    const graph = (listData['@graph'] as ProductListEntry[] | undefined) ?? [];

    if (graph.length === 0) {
      if (!(await this.probeRecord(`${BASE_URL}/offices/${office}`, ctx))) throw unknownOffice();
      if (productType === 'HWO' || productType === 'SPS') {
        throw notFound(
          `No ${productType} products are currently available for office "${office}". ${productType} products are episodic — most offices have none active most of the time. Try a different product type (AFD is near-always available).`,
          {
            office,
            productType,
            reason: 'no_products',
            recovery: {
              hint: `${productType} products are issued only when conditions warrant. Retry with product_type "AFD" for the always-available forecast discussion.`,
            },
          },
        );
      }
      if (productType === 'FWF') {
        throw notFound(
          `Office "${office}" has no FWF (Fire Weather Planning Forecast) on file — not every Weather Forecast Office issues one.`,
          {
            office,
            productType,
            reason: 'no_products',
            recovery: {
              hint: `Retry with product_type "AFD" for this office's forecast discussion. For a fire zone from an alert, use the office in that alert's "office" field with product_type "FWF".`,
            },
          },
        );
      }
      // AFD and ZFP are routine; an empty list means the office files them under another code.
      throw notFound(
        `No ${productType} product is filed under location code "${office}". Some offices file a product under location codes other than their WFO code — Anchorage (AFC) files its ZFP under "AER" (Anchorage East) and "ALU" (Anchorage West), and San Juan (SJU) its ZFP under "PR".`,
        {
          office,
          productType,
          reason: 'no_products',
          recovery: {
            hint:
              productType === 'ZFP'
                ? `Retry with the location code the office files its ZFP under (Anchorage: "AER" or "ALU"; San Juan: "PR"), or use nws_get_zone_forecast with a zone code for one zone's text forecast.`
                : `Confirm the WFO code from the "office" field of nws_get_forecast output and retry with it.`,
          },
        },
      );
    }

    // graph.length > 0 is checked above; the first item is always present here.
    const latest = graph[0] as ProductListEntry;
    const productUrl = `${BASE_URL}/products/${latest.id}`;
    ctx.log.info('Fetching product detail', { id: latest.id });

    const detail = await nwsFetch<Record<string, unknown>>(productUrl, ctx, MAX_RETRIES);

    return {
      issuanceTime: detail.issuanceTime as string,
      issuingOffice: detail.issuingOffice as string,
      productCode: detail.productCode as string,
      productName: detail.productName as string,
      productText: detail.productText as string,
      wmoCollectiveId: detail.wmoCollectiveId as string,
    };
  }

  /**
   * Probe an NWS record (`/offices/{id}`, `/zones/forecast/{id}`) on an error path
   * where the failed request cannot tell a valid ID with nothing to serve from an
   * unknown one: the record body on HTTP 200, undefined on 404. A single request
   * with no retries and no caching. Any other failure re-throws — an outage is not
   * an answer about the ID.
   */
  private async probeRecord(
    url: string,
    ctx: Context,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      return await nwsFetch<Record<string, unknown>>(url, ctx, 0, DEFAULT_NOT_FOUND, (message) =>
        notFound(message, { probe: 'record-not-found' }),
      );
    } catch (error) {
      if (error instanceof McpError && error.data?.probe === 'record-not-found') return;
      throw error;
    }
  }

  /** Get the text forecast for a land (public) or marine forecast zone. */
  async getZoneForecast(zoneId: string, ctx: Context): Promise<ZoneForecastResult> {
    // The tool's contract owns every recovery text below: each throw carries only
    // its reason, and the framework fills the matching contract hint, so there is
    // one copy rather than a second that drifts from the first. The one exception
    // is zone_forecast_unavailable with a point inside the zone, whose hint names it.
    const zoneNotFound = () =>
      notFound(
        `Zone "${zoneId}" is not an NWS forecast zone. Provide a forecast zone code (e.g., "WAZ315"). Forecast zone codes are returned by nws_get_forecast (the "forecastZone" field), nws_find_stations (the "forecastZone" column), and nws_search_alerts as "affectedZones" entries with type "forecast" — county zones have no text forecast product. A fire zone from an alert has its forecast in a segment of the office's Fire Weather Planning Forecast: call nws_get_office_discussion with office set to the alert's "office" field, product_type "FWF", and sections set to the zone code.`,
        { zoneId, reason: 'zone_not_found' },
      );
    const marineZoneUnsupported = () =>
      marineForecastUnsupported(
        `Zone "${zoneId}" is a marine zone with no text forecast from NWS; text forecast availability varies across marine zones.`,
        { zoneId },
      );
    if (!PATH_ID_PATTERN.test(zoneId)) throw zoneNotFound();

    const zonePath = `${BASE_URL}/zones/forecast/${zoneId}`;
    ctx.log.info('Fetching zone forecast', { zoneId });

    /**
     * NWS types a 404 `NotFound` both for a valid zone with no text product and
     * for a made-up zone with an unknown prefix, so that answer — like a 500 that
     * outlives the retry budget, which some valid zones return on every attempt —
     * is settled by probing the zone record, whose `type` also tells a land zone
     * from a marine one. A zone that serves its forecast is never probed.
     */
    let notFoundIsAmbiguous = false;

    const data = await nwsFetch<Record<string, unknown>>(
      `${zonePath}/forecast`,
      ctx,
      MAX_RETRIES,
      DEFAULT_NOT_FOUND,
      (_message, problemType) => {
        if (problemType === MARINE_FORECAST_NOT_SUPPORTED) return marineZoneUnsupported();
        notFoundIsAmbiguous = problemType === 'NotFound';
        return zoneNotFound();
      },
    ).catch(async (error: unknown) => {
      // Gateway statuses (502-504), 501, and every other failure say nothing about
      // this zone's product and surface unchanged.
      let status: 404 | 500;
      if (notFoundIsAmbiguous) status = 404;
      else if (error instanceof McpError && error.data?.status === 500) status = 500;
      else throw error;

      const record = await this.probeRecord(zonePath, ctx).catch((probeError: unknown) => {
        // An unanswered probe leaves the zone question open: a 500 keeps its own
        // failure, while a NotFound 404, which claims nothing alone, yields the
        // probe's. A caller that went away is always a cancellation.
        throw notFoundIsAmbiguous || ctx.signal.aborted ? probeError : error;
      });
      if (!record) throw zoneNotFound();

      /**
       * A marine zone's interior point is in the water, where nws_get_forecast
       * refuses too. Its NotFound 404 is the same "no text forecast" answer an
       * offshore zone gives as MarineForecastNotSupported; a 500 says nothing about
       * the product (most coastal zones serve one), so it keeps its own failure.
       */
      const zoneType = (record.properties as { type?: unknown } | undefined)?.type;
      if (MARINE_ZONE_TYPES.has(zoneType)) {
        if (status === 500) throw error;
        throw marineZoneUnsupported();
      }

      // The record's geometry yields a point for nws_get_forecast with no extra request;
      // without one, the contract recovery stands.
      const point = interiorPoint(record.geometry);
      const unavailable = `Zone "${zoneId}" exists, but NWS has no text forecast for it — the forecast request returned HTTP ${status}.`;
      throw notFound(
        point
          ? `${unavailable} (${point.latitude}, ${point.longitude}) is a point inside the zone.`
          : unavailable,
        {
          zoneId,
          upstreamStatus: status,
          ...(point && {
            ...point,
            recovery: {
              hint: `Call nws_get_forecast with latitude ${point.latitude} and longitude ${point.longitude}, a point inside ${zoneId}, for its point forecast; NWS usually serves one where a zone has no zone text product.`,
            },
          }),
          reason: 'zone_forecast_unavailable',
        },
        { cause: error },
      );
    });

    const props = data.properties as Record<string, unknown>;
    const rawPeriods = (props.periods as Record<string, unknown>[]) ?? [];
    const periods: ZoneForecastPeriod[] = rawPeriods.map((p) => ({
      number: p.number as number,
      name: p.name as string,
      detailedForecast: p.detailedForecast as string,
    }));

    return {
      zoneId,
      updated: props.updated as string,
      periods,
    };
  }
}

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

let _service: NwsService | undefined;

export function initNwsService(): void {
  _service = new NwsService();
}

export function getNwsService(): NwsService {
  if (!_service) throw new Error('NwsService not initialized — call initNwsService() in setup()');
  return _service;
}
