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

/** Active alert from /alerts/active. */
export interface Alert {
  readonly affectedZones: readonly string[];
  readonly areaDesc: string;
  readonly certainty: string;
  readonly description: string;
  readonly event: string;
  readonly expires: string | null;
  readonly headline: string | null;
  readonly id: string;
  readonly instruction: string | null;
  readonly onset: string | null;
  readonly senderName: string;
  readonly severity: string;
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
