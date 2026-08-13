/**
 * @fileoverview Type definitions for NWS API responses.
 * @module services/nws/types
 */

/** NWS quantity value — many observation fields use this shape. */
export interface NwsValue {
  readonly unitCode: string;
  readonly value: number | null;
}

/** Resolved grid point from /points/{lat},{lon}. */
export interface PointsMetadata {
  readonly city: string;
  readonly county: string;
  readonly forecastHourlyUrl: string;
  readonly forecastUrl: string;
  readonly forecastZone: string;
  readonly gridX: number;
  readonly gridY: number;
  readonly observationStationsUrl: string;
  readonly office: string;
  readonly state: string;
  readonly timeZone: string;
}

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
  readonly updateTime: string;
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
  readonly headline: string | null;
  readonly id: string;
  readonly instruction: string | null;
  readonly messageType: string;
  readonly onset: string | null;
  readonly references: readonly AlertReference[];
  readonly senderName: string;
  readonly sent: string;
  readonly severity: string;
  readonly status: string;
  readonly urgency: string;
}

/** Latest observation from /stations/{id}/observations/latest. */
export interface Observation {
  readonly barometricPressure: NwsValue;
  readonly cloudLayers: readonly CloudLayer[];
  readonly dewpoint: NwsValue;
  readonly heatIndex: NwsValue;
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
