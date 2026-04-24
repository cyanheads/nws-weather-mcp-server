/**
 * @fileoverview NWS API client service. Handles HTTP requests, /points resolution
 * with caching, and retry logic for transient failures.
 * @module services/nws/nws-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import type {
  Alert,
  ForecastPeriod,
  ForecastResponse,
  NwsValue,
  Observation,
  PointsMetadata,
  Station,
} from './types.js';

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
  'NWS only covers the US. Provide coordinates within US states, territories, or adjacent marine areas.';

type NotFoundFactory = (message: string) => Error;

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

function isRetryableNwsError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof McpError) {
    return [
      JsonRpcErrorCode.ServiceUnavailable,
      JsonRpcErrorCode.Timeout,
      JsonRpcErrorCode.RateLimited,
    ].includes(error.code);
  }
  return false;
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
    if (ctx.signal.aborted) throw error;

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
    const isHtml = /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
    const msg = isHtml
      ? 'NWS API returned HTML instead of JSON. Retry in a few seconds.'
      : 'NWS API returned invalid JSON. Retry in a few seconds.';
    throw serviceUnavailable(msg, { url }, { cause: error });
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
        throw notFoundFactory(notFoundMessage);
      }

      if (response.status === 400) {
        const detail = parseNwsErrorDetail(text);
        throw validationError(detail ?? `NWS API returned 400: Bad Request for ${url}`, {
          url,
          status: response.status,
        });
      }

      if (response.status === 429) {
        throw rateLimited('NWS API rate-limited the request. Retry in a few seconds.', {
          url,
          status: response.status,
        });
      }

      throw serviceUnavailable(`NWS API returned ${response.status}: ${response.statusText}`, {
        url,
        status: response.status,
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
    if (!isRetryableNwsError(error) || ctx.signal.aborted) {
      throw error;
    }

    if (error instanceof McpError) {
      throw error;
    }

    throw serviceUnavailable(
      `NWS API unavailable after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
      { url, retryAttempts: attempts },
      { cause: error },
    );
  });
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
    (message) => validationError(message, { lat: tLat, lon: tLon }),
  );

  const props = data.properties as Record<string, unknown>;
  const relativeLocation = (props.relativeLocation as Record<string, unknown>)
    ?.properties as Record<string, string>;

  const forecastUrl = props.forecast as string | undefined;
  const forecastHourlyUrl = props.forecastHourly as string | undefined;
  const observationStationsUrl = props.observationStations as string | undefined;

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
    office: props.gridId as string,
    gridX: props.gridX as number,
    gridY: props.gridY as number,
    forecastUrl,
    forecastHourlyUrl,
    observationStationsUrl,
    city: relativeLocation?.city ?? '',
    state: relativeLocation?.state ?? '',
    timeZone: props.timeZone as string,
    forecastZone: extractZoneCode((props.forecastZone as string) ?? ''),
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
    updateTime: props.updateTime as string,
    periods,
  };
}

/** Parse a single alert from GeoJSON feature. */
function parseAlert(feature: Record<string, unknown>): Alert {
  const p = feature.properties as Record<string, unknown>;
  return {
    id: p.id as string,
    event: p.event as string,
    headline: (p.headline as string) ?? null,
    description: p.description as string,
    instruction: (p.instruction as string) ?? null,
    severity: p.severity as string,
    urgency: p.urgency as string,
    certainty: p.certainty as string,
    areaDesc: p.areaDesc as string,
    onset: (p.onset as string) ?? null,
    expires: (p.expires as string) ?? null,
    senderName: p.senderName as string,
    affectedZones: ((p.affectedZones as string[]) ?? []).map(extractZoneCode),
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
    cloudLayers: ((props.cloudLayers as Record<string, unknown>[]) ?? []).map((l) => ({
      base: (l.base as NwsValue) ?? nullValue,
      amount: (l.amount as string) ?? 'CLR',
    })),
  };
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
  readonly stations: readonly StationResult[];
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
    const url = hourly ? points.forecastHourlyUrl : points.forecastUrl;

    ctx.log.info('Fetching forecast', { url, hourly });
    const data = await nwsFetch<Record<string, unknown>>(url, ctx);

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
    if (params.severity?.length) url.searchParams.set('severity', params.severity.join(','));
    if (params.urgency?.length) url.searchParams.set('urgency', params.urgency.join(','));
    if (params.certainty?.length) url.searchParams.set('certainty', params.certainty.join(','));
    const normalizedStatus = params.status?.trim().toLowerCase();
    if (normalizedStatus) url.searchParams.set('status', normalizedStatus);

    ctx.log.info('Searching alerts', { url: url.toString() });
    const data = await nwsFetch<Record<string, unknown>>(url.toString(), ctx);

    const features = (data.features ?? []) as Record<string, unknown>[];
    const eventFilters = params.event
      ?.map((event) => event.trim().toLowerCase())
      .filter((event) => event.length > 0);
    const alerts = features.map(parseAlert).filter((alert) => {
      if (!eventFilters?.length) return true;
      const normalizedEvent = alert.event.toLowerCase();
      return eventFilters.some((event) => normalizedEvent.includes(event));
    });
    return { alerts };
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
      const notFoundMsg = `Station '${stationId}' not found. Use nws_find_stations to discover valid station IDs.`;

      ctx.log.info('Fetching station metadata and latest observation', { stationId });
      const [stationData, obsData] = await Promise.all([
        nwsFetch<Record<string, unknown>>(`${BASE_URL}/stations/${stationId}`, ctx, 0, notFoundMsg),
        nwsFetch<Record<string, unknown>>(
          `${BASE_URL}/stations/${stationId}/observations/latest`,
          ctx,
          MAX_RETRIES,
          notFoundMsg,
        ),
      ]);

      const stationProps = stationData.properties as Record<string, unknown>;
      const stationName = (stationProps?.name as string) ?? stationId;
      const timeZone =
        typeof stationProps?.timeZone === 'string' ? (stationProps.timeZone as string) : null;
      const observation = parseObservation(obsData, stationId, stationName, timeZone);
      if (!observation.timestamp) {
        throw notFound(
          `Station ${stationId} has no recent observations. Try a different station — use nws_find_stations to find alternatives nearby.`,
          { stationId },
        );
      }
      return { observation };
    }

    // Coordinates — resolve nearest station, then fetch observation sequentially
    const lat = params.latitude as number;
    const lon = params.longitude as number;
    const points = await resolvePoints(lat, lon, ctx);
    ctx.log.info('Resolving nearest station', { url: points.observationStationsUrl });
    const stationsData = await nwsFetch<Record<string, unknown>>(
      points.observationStationsUrl,
      ctx,
      0,
    );
    const nearestStation = parseStations(stationsData)
      .map((station) => ({
        station,
        distance: haversine(lat, lon, station.coordinates[1], station.coordinates[0]),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.station;

    if (!nearestStation) {
      throw notFound('No observation stations found near this location.', {
        latitude: lat,
        longitude: lon,
      });
    }
    const stationId = nearestStation.stationId;
    const stationName = nearestStation.name;

    ctx.log.info('Fetching latest observation', { stationId });
    const data = await nwsFetch<Record<string, unknown>>(
      `${BASE_URL}/stations/${stationId}/observations/latest`,
      ctx,
      MAX_RETRIES,
      `Station '${stationId}' not found. Use nws_find_stations to discover valid station IDs.`,
    );

    const observation = parseObservation(data, stationId, stationName, nearestStation.timeZone);
    if (!observation.timestamp) {
      throw notFound(
        `Station ${stationId} has no recent observations. Try a different station — use nws_find_stations to find alternatives nearby.`,
        { stationId },
      );
    }
    return { observation };
  }

  /** Find observation stations near coordinates, sorted by proximity. */
  async findStations(
    lat: number,
    lon: number,
    limit: number,
    ctx: Context,
  ): Promise<FindStationsResult> {
    const points = await resolvePoints(lat, lon, ctx);

    ctx.log.info('Fetching stations', { url: points.observationStationsUrl });
    const data = await nwsFetch<Record<string, unknown>>(points.observationStationsUrl, ctx, 0);

    const stations = parseStations(data).map((s) => {
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

    return { stations: stations.slice(0, limit) };
  }

  /** List all valid alert event type names. */
  async listAlertTypes(ctx: Context): Promise<readonly string[]> {
    ctx.log.info('Fetching alert types');
    const data = await nwsFetch<Record<string, unknown>>(`${BASE_URL}/alerts/types`, ctx, 0);
    return (data.eventTypes as string[]) ?? [];
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
