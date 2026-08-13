/**
 * @fileoverview Shared NWS API response fixtures for tests.
 * @module tests/fixtures/nws-responses
 */

/** Mock /points/{lat},{lon} response */
export const pointsResponse = {
  properties: {
    gridId: 'SEW',
    gridX: 125,
    gridY: 68,
    forecast: 'https://api.weather.gov/gridpoints/SEW/125,68/forecast',
    forecastHourly: 'https://api.weather.gov/gridpoints/SEW/125,68/forecast/hourly',
    observationStations: 'https://api.weather.gov/gridpoints/SEW/125,68/stations',
    relativeLocation: {
      properties: {
        city: 'Seattle',
        state: 'WA',
      },
    },
    timeZone: 'America/Los_Angeles',
    forecastZone: 'https://api.weather.gov/zones/forecast/WAZ558',
    county: 'https://api.weather.gov/zones/county/WAC033',
  },
};

/** Mock forecast response */
export const forecastResponse = {
  properties: {
    generatedAt: '2026-04-03T12:00:00Z',
    updateTime: '2026-04-03T12:00:00Z',
    periods: [
      {
        number: 1,
        name: 'Today',
        startTime: '2026-04-03T06:00:00-07:00',
        endTime: '2026-04-03T18:00:00-07:00',
        isDaytime: true,
        temperature: 62,
        temperatureUnit: 'F',
        windSpeed: '10 mph',
        windDirection: 'NW',
        shortForecast: 'Mostly Sunny',
        detailedForecast: 'Mostly sunny, with a high near 62. Northwest wind around 10 mph.',
        probabilityOfPrecipitation: { value: 10, unitCode: 'wmoUnit:percent' },
        dewpoint: { value: 8.5, unitCode: 'wmoUnit:degC' },
        relativeHumidity: { value: 55, unitCode: 'wmoUnit:percent' },
      },
      {
        number: 2,
        name: 'Tonight',
        startTime: '2026-04-03T18:00:00-07:00',
        endTime: '2026-04-04T06:00:00-07:00',
        isDaytime: false,
        temperature: 45,
        temperatureUnit: 'F',
        windSpeed: '5 mph',
        windDirection: 'S',
        shortForecast: 'Partly Cloudy',
        detailedForecast: 'Partly cloudy, with a low around 45.',
        probabilityOfPrecipitation: { value: 5, unitCode: 'wmoUnit:percent' },
        dewpoint: { value: 6.0, unitCode: 'wmoUnit:degC' },
        relativeHumidity: { value: 70, unitCode: 'wmoUnit:percent' },
      },
    ],
  },
};

/** Mock /alerts/active response — an original issuance with no prior references. */
export const alertsResponse = {
  features: [
    {
      properties: {
        id: 'urn:oid:2.49.0.1.840.0.abc123',
        event: 'Wind Advisory',
        headline: 'Wind Advisory issued April 3 at 6:00AM PDT',
        description: 'Strong winds expected with gusts up to 50 mph.',
        instruction: 'Secure outdoor objects. Use caution while driving.',
        severity: 'Moderate',
        urgency: 'Expected',
        certainty: 'Likely',
        areaDesc: 'King County; Snohomish County',
        sent: '2026-04-03T06:00:00-07:00',
        effective: '2026-04-03T06:00:00-07:00',
        onset: '2026-04-03T12:00:00-07:00',
        ends: '2026-04-03T18:00:00-07:00',
        expires: '2026-04-04T00:00:00-07:00',
        status: 'Actual',
        messageType: 'Alert',
        references: [],
        senderName: 'NWS Seattle WA',
        affectedZones: ['https://api.weather.gov/zones/forecast/WAZ558'],
      },
    },
  ],
};

/**
 * Mock /alerts/active response covering every affectedZones typing NWS emits:
 * a forecast-only alert, a county-only alert, and one mixing forecast, county,
 * and fire zones in a single array.
 */
export const zoneTypedAlertsResponse = {
  features: [
    {
      properties: {
        id: 'urn:oid:forecast-only',
        event: 'Wind Advisory',
        headline: 'Wind Advisory in effect',
        description: 'Strong winds.',
        instruction: null,
        severity: 'Moderate',
        urgency: 'Expected',
        certainty: 'Likely',
        areaDesc: 'Seattle and Vicinity',
        sent: '2026-04-03T06:00:00-07:00',
        effective: '2026-04-03T06:00:00-07:00',
        onset: '2026-04-03T12:00:00-07:00',
        ends: '2026-04-03T18:00:00-07:00',
        expires: '2026-04-04T00:00:00-07:00',
        status: 'Actual',
        messageType: 'Alert',
        references: [],
        senderName: 'NWS Seattle WA',
        affectedZones: [
          'https://api.weather.gov/zones/forecast/WAZ558',
          'https://api.weather.gov/zones/forecast/WAZ507',
        ],
      },
    },
    {
      properties: {
        id: 'urn:oid:county-only',
        event: 'Severe Thunderstorm Warning',
        headline: 'Severe Thunderstorm Warning in effect',
        description: 'Damaging winds and large hail.',
        instruction: 'Move indoors.',
        severity: 'Severe',
        urgency: 'Immediate',
        certainty: 'Observed',
        areaDesc: 'King County',
        sent: '2026-04-03T13:00:00-07:00',
        effective: '2026-04-03T13:00:00-07:00',
        onset: '2026-04-03T13:00:00-07:00',
        ends: '2026-04-03T14:00:00-07:00',
        expires: '2026-04-03T14:00:00-07:00',
        status: 'Actual',
        messageType: 'Alert',
        references: [],
        senderName: 'NWS Seattle WA',
        affectedZones: ['https://api.weather.gov/zones/county/WAC033'],
      },
    },
    {
      properties: {
        id: 'urn:oid:mixed-zones',
        event: 'Red Flag Warning',
        headline: 'Red Flag Warning in effect',
        description: 'Critical fire weather.',
        instruction: null,
        severity: 'Severe',
        urgency: 'Expected',
        certainty: 'Likely',
        areaDesc: 'Central Washington',
        sent: '2026-04-03T09:00:00-07:00',
        effective: '2026-04-03T09:00:00-07:00',
        onset: '2026-04-03T11:00:00-07:00',
        ends: null,
        expires: '2026-04-04T03:00:00-07:00',
        status: 'Actual',
        messageType: 'Alert',
        references: [],
        senderName: 'NWS Pendleton OR',
        affectedZones: [
          'https://api.weather.gov/zones/forecast/WAZ027',
          'https://api.weather.gov/zones/county/WAC007',
          'https://api.weather.gov/zones/fire/WAZ690',
        ],
      },
    },
  ],
};

/**
 * Mock /alerts/active response for a CAP Update — supersedes two prior messages.
 * Upstream reference entries also carry `@id` and `sender`, which the service
 * compacts away.
 */
export const updateAlertsResponse = {
  features: [
    {
      properties: {
        id: 'urn:oid:2.49.0.1.840.0.update.002.1',
        event: 'Flash Flood Watch',
        headline: 'Flash Flood Watch remains in effect',
        description: 'Heavy rain continues.',
        instruction: 'Avoid low water crossings.',
        severity: 'Severe',
        urgency: 'Future',
        certainty: 'Possible',
        areaDesc: 'Santa Fe County',
        sent: '2026-08-12T22:14:00-06:00',
        effective: '2026-08-12T22:10:00-06:00',
        onset: '2026-08-13T06:00:00-06:00',
        ends: '2026-08-13T18:00:00-06:00',
        expires: '2026-08-13T10:14:00-06:00',
        status: 'Actual',
        messageType: 'Update',
        references: [
          {
            '@id': 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.update.001.1',
            identifier: 'urn:oid:2.49.0.1.840.0.update.001.1',
            sender: 'w-nws.webmaster@noaa.gov',
            sent: '2026-08-12T21:54:00-06:00',
          },
          {
            '@id': 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.update.000.1',
            identifier: 'urn:oid:2.49.0.1.840.0.update.000.1',
            sender: 'w-nws.webmaster@noaa.gov',
            sent: '2026-08-12T18:30:00-06:00',
          },
        ],
        senderName: 'NWS Albuquerque NM',
        affectedZones: ['https://api.weather.gov/zones/county/NMC049'],
      },
    },
  ],
};

/** Empty alerts response */
export const emptyAlertsResponse = {
  features: [],
};

/** Mock /alerts/types response */
export const alertTypesResponse = {
  '@context': [],
  eventTypes: [
    'Blizzard Warning',
    'Flash Flood Watch',
    'Severe Thunderstorm Warning',
    'Tornado Warning',
    'Wind Advisory',
    'Winter Storm Watch',
  ],
};

/** Mock /stations/{id}/observations/latest response */
export const observationResponse = {
  properties: {
    timestamp: '2026-04-03T11:53:00+00:00',
    textDescription: 'Mostly Cloudy',
    temperature: { value: 14.4, unitCode: 'wmoUnit:degC' },
    dewpoint: { value: 8.3, unitCode: 'wmoUnit:degC' },
    windSpeed: { value: 18.5, unitCode: 'wmoUnit:km_h-1' },
    windDirection: { value: 200, unitCode: 'wmoUnit:degree_(angle)' },
    windGust: { value: null, unitCode: 'wmoUnit:km_h-1' },
    barometricPressure: { value: 101325, unitCode: 'wmoUnit:Pa' },
    visibility: { value: 16093, unitCode: 'wmoUnit:m' },
    relativeHumidity: { value: 65.2, unitCode: 'wmoUnit:percent' },
    heatIndex: { value: null, unitCode: 'wmoUnit:degC' },
    windChill: { value: null, unitCode: 'wmoUnit:degC' },
    cloudLayers: [{ base: { value: 1524, unitCode: 'wmoUnit:m' }, amount: 'BKN' }],
  },
};

/** Mock /stations/{id} response (single station info) */
export const stationInfoResponse = {
  properties: {
    stationIdentifier: 'KSEA',
    name: 'Seattle, Seattle-Tacoma International Airport',
    elevation: { value: 131, unitCode: 'wmoUnit:m' },
    timeZone: 'America/Los_Angeles',
  },
};

/** Mock observation stations response */
export const stationsResponse = {
  features: [
    {
      properties: {
        stationIdentifier: 'KSEA',
        name: 'Seattle-Tacoma International Airport',
        elevation: { value: 131, unitCode: 'wmoUnit:m' },
        timeZone: 'America/Los_Angeles',
        county: 'https://api.weather.gov/zones/county/WAC033',
        forecast: 'https://api.weather.gov/zones/forecast/WAZ558',
      },
      geometry: { coordinates: [-122.3088, 47.4444] },
    },
    {
      properties: {
        stationIdentifier: 'KBFI',
        name: 'Seattle Boeing Field',
        elevation: { value: 6, unitCode: 'wmoUnit:m' },
        timeZone: 'America/Los_Angeles',
        county: 'https://api.weather.gov/zones/county/WAC033',
        forecast: 'https://api.weather.gov/zones/forecast/WAZ558',
      },
      geometry: { coordinates: [-122.302, 47.53] },
    },
    {
      properties: {
        stationIdentifier: 'KPAE',
        name: 'Snohomish County Airport',
        elevation: { value: 183, unitCode: 'wmoUnit:m' },
        timeZone: 'America/Los_Angeles',
        county: 'https://api.weather.gov/zones/county/WAC061',
        forecast: 'https://api.weather.gov/zones/forecast/WAZ507',
      },
      geometry: { coordinates: [-122.2815, 47.9063] },
    },
  ],
};
