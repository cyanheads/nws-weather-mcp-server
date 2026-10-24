/**
 * @fileoverview Type definitions for NWS API responses.
 * @module services/nws/types
 */

/** NWS quantity value — many observation fields use this shape. */
export interface NwsValue {
  readonly unitCode: string;
  readonly value: number | null;
}

/** A /points cell inside the NWS forecast grid, with the URLs that route from it. */
export interface GriddedPoint {
  readonly city: string;
  readonly county: string;
  readonly forecastGridDataUrl: string | undefined;
  readonly forecastHourlyUrl: string;
  readonly forecastUrl: string;
  readonly forecastZone: string;
  readonly gridX: number;
  readonly gridY: number;
  readonly kind: 'gridded';
  readonly observationStationsUrl: string;
  readonly office: string;
  readonly state: string;
  readonly timeZone: string;
}

/**
 * An offshore marine point beyond the forecast grid. NWS answers `/points` with
 * HTTP 200, `type: "marine"`, and every grid field null — there is no forecast
 * or station URL to follow, only the marine zone the point falls in.
 */
export interface GridlessMarinePoint {
  /** Marine forecast zone code, e.g. `GMZ056`. */
  readonly forecastZone: string;
  readonly kind: 'gridless_marine';
}

/**
 * A land point NWS resolves but serves no forecast grid for (e.g. interior points
 * of the Northern Mariana Islands zones MPZ005–MPZ007). NWS answers `/points` with
 * HTTP 200, `type: "land"`, and every grid field null; only the forecast zone is real.
 */
export interface GridlessLandPoint {
  /** Public forecast zone code, e.g. `MPZ006`. */
  readonly forecastZone: string;
  readonly kind: 'gridless_land';
}

/** Resolved /points/{lat},{lon} metadata. */
export type PointsMetadata = GriddedPoint | GridlessMarinePoint | GridlessLandPoint;

/** A single forecast period (shared by standard and hourly). */
export interface ForecastPeriod {
  readonly detailedForecast: string;
  readonly dewpoint: NwsValue;
  readonly endTime: string;
  readonly isDaytime: boolean;
  readonly name: string;
  readonly number: number;
  readonly probabilityOfPrecipitation: NwsValue;
  readonly relativeHumidity: NwsValue;
  readonly shortForecast: string;
  readonly startTime: string;
  readonly temperature: number;
  readonly temperatureUnit: string;
  readonly windDirection: string;
  readonly windSpeed: string;
}

/** Forecast response from /gridpoints/{wfo}/{x},{y}/forecast. */
export interface ForecastResponse {
  readonly generatedAt: string;
  readonly periods: readonly ForecastPeriod[];
  /** Null when NWS omits it; the OpenAPI spec marks it optional. */
  readonly updateTime: string | null;
}

/** Native quantitative grid layers; interval strings and missing measurements stay unchanged. */
export interface PrecipitationAmount {
  readonly layer: 'quantitativePrecipitation' | 'snowfallAmount' | 'iceAccumulation';
  readonly uom: string | null;
  readonly values: { readonly validTime: string; readonly value: number | null }[];
}

/**
 * One entry of an alert's `affectedZones`, with the zone type NWS encodes in the
 * zone URL path preserved alongside the code. The types are not interchangeable:
 * only `forecast` zones have a zone text forecast, so callers need the type to
 * know which codes chain into `nws_get_zone_forecast`.
 */
export interface AffectedZone {
  /** Zone code, e.g. `WAZ558` (forecast) or `WAC033` (county). */
  readonly code: string;
  /**
   * NWS zone type from the `/zones/{type}/{code}` URL — `forecast`, `county`, or
   * `fire`. `unknown` when the upstream value is not a zone URL.
   */
  readonly type: string;
}

/** A prior CAP message this alert supersedes, compacted to the identifying pair. */
export interface AlertReference {
  /** CAP identifier of the superseded message. */
  readonly identifier: string;
  /** When the superseded message was issued (ISO 8601). */
  readonly sent: string;
}

/** The CAP `parameters` hazard tags an alert can carry, under their NWS key names. */
export const ALERT_HAZARD_KEYS = [
  'maxHailSize',
  'maxWindGust',
  'hailThreat',
  'windThreat',
  'tornadoDetection',
  'tornadoDamageThreat',
  'thunderstormDamageThreat',
  'flashFloodDetection',
  'flashFloodDamageThreat',
  'waterspoutDetection',
  'eventMotionDescription',
] as const;

/** Hazard tags NWS sent, values verbatim; a key NWS did not send is absent, never null. */
export type AlertHazard = {
  readonly [K in (typeof ALERT_HAZARD_KEYS)[number]]?: string | undefined;
};

/** Active alert from /alerts/active. */
export interface Alert {
  readonly affectedZones: readonly AffectedZone[];
  readonly areaDesc: string;
  readonly certainty: string;
  /** NWS omits this on some alerts (e.g. a Coastal Flood Advisory) — issue #37. */
  readonly description: string | null;
  readonly effective: string;
  readonly ends: string | null;
  readonly event: string;
  readonly expires: string | null;
  /** Null when NWS sends none of the hazard keys. */
  readonly hazard: AlertHazard | null;
  readonly headline: string | null;
  readonly id: string;
  readonly instruction: string | null;
  readonly messageType: string;
  /** CAP `NWSheadline`, distinct from `headline`. */
  readonly nwsHeadline: string | null;
  /**
   * Issuing office code (`RIW`) from the WMO header's issuing centre — the code
   * `nws_get_office_discussion` takes. Null for a centre with no office
   * discussion, or a missing or malformed header.
   */
  readonly office: string | null;
  readonly onset: string | null;
  readonly references: readonly AlertReference[];
  readonly senderName: string;
  readonly sent: string;
  readonly severity: string;
  readonly status: string;
  readonly urgency: string;
  /** Raw P-VTEC strings; empty when NWS sends none. */
  readonly vtec: readonly string[];
}

/**
 * Active alert counts from /alerts/active/count, across every CAP status. Counts
 * key on each alert's UGC codes, so an alert covering several areas counts once
 * per area. The upstream `zones` map is not carried.
 */
export interface AlertCounts {
  /** Counts per state/territory or marine area code; only codes with an active alert appear. */
  readonly areas: Readonly<Record<string, number>>;
  readonly land: number;
  readonly marine: number;
  /** Counts per marine region (AL, AT, GL, GM, PA, PI); only regions with an active alert appear. */
  readonly regions: Readonly<Record<string, number>>;
  readonly total: number;
}

/** Latest observation from /stations/{id}/observations/latest. */
export interface Observation {
  readonly barometricPressure: NwsValue;
  readonly cloudLayers: readonly CloudLayer[];
  readonly dewpoint: NwsValue;
  readonly heatIndex: NwsValue;
  /** mm, from the METAR 6-group on the 03/09/15/21 UTC reports; 0 is a trace, null no amount. */
  readonly precipitationLast3Hours: NwsValue;
  /** mm, from the METAR 6-group on the 00/06/12/18 UTC reports; 0 is a trace, null no amount. */
  readonly precipitationLast6Hours: NwsValue;
  /** mm, from the METAR P group; 0 is a trace, null no amount (the group is omitted when dry). */
  readonly precipitationLastHour: NwsValue;
  readonly relativeHumidity: NwsValue;
  readonly stationId: string;
  readonly stationName: string;
  readonly temperature: NwsValue;
  readonly textDescription: string;
  readonly timestamp: string;
  readonly timeZone: string | null;
  readonly visibility: NwsValue;
  readonly windChill: NwsValue;
  readonly windDirection: NwsValue;
  readonly windGust: NwsValue;
  readonly windSpeed: NwsValue;
}

/** Cloud layer from observation data. */
export interface CloudLayer {
  readonly amount: string;
  readonly base: NwsValue;
}

/** Observation station from /points/{lat},{lon}/stations. */
export interface Station {
  readonly coordinates: readonly [longitude: number, latitude: number];
  readonly county: string;
  readonly elevation: NwsValue;
  readonly forecastZone: string;
  readonly name: string;
  readonly stationId: string;
  readonly timeZone: string;
}

/** Product list entry from /products/types/{type}/locations/{office} — no productText. */
export interface ProductListEntry {
  readonly id: string;
  readonly issuanceTime: string;
  readonly issuingOffice: string;
  readonly productCode: string;
  readonly productName: string;
  readonly wmoCollectiveId: string;
}

/** Full product from /products/{id} — includes productText. */
export interface ProductDetail extends ProductListEntry {
  readonly productText: string;
}

/** Zone forecast response from /zones/forecast/{zone_id}/forecast. */
export interface ZoneForecastResponse {
  readonly periods: readonly ZoneForecastPeriod[];
  readonly updated: string;
}

/** Single period from a zone forecast. */
export interface ZoneForecastPeriod {
  readonly detailedForecast: string;
  readonly name: string;
  readonly number: number;
}
