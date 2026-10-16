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
 * Mock /alerts/active response carrying the upstream duplication NWS emits: the
 * same alert repeated byte-for-byte within one fetch (identical `id`, `sent`,
 * `event`, and `areaDesc`), interleaved with a distinct alert so tests can also
 * pin that collapsing the copies preserves first-occurrence order.
 */
export const duplicateAlertsResponse = {
  features: [
    {
      properties: {
        id: 'urn:oid:duplicated-air-quality',
        event: 'Air Quality Alert',
        headline: 'Air Quality Alert in effect',
        description: 'Smoke has degraded air quality.',
        instruction: 'Limit outdoor exertion.',
        severity: 'Moderate',
        urgency: 'Expected',
        certainty: 'Likely',
        areaDesc: 'Central Washington',
        sent: '2026-04-03T08:00:00-07:00',
        effective: '2026-04-03T08:00:00-07:00',
        onset: '2026-04-03T08:00:00-07:00',
        ends: '2026-04-04T08:00:00-07:00',
        expires: '2026-04-03T20:00:00-07:00',
        status: 'Actual',
        messageType: 'Alert',
        references: [],
        senderName: 'NWS Pendleton OR',
        affectedZones: ['https://api.weather.gov/zones/forecast/WAZ027'],
      },
    },
    {
      properties: {
        id: 'urn:oid:distinct-wind-advisory',
        event: 'Wind Advisory',
        headline: 'Wind Advisory in effect',
        description: 'Strong winds expected.',
        instruction: 'Secure outdoor objects.',
        severity: 'Moderate',
        urgency: 'Expected',
        certainty: 'Likely',
        areaDesc: 'King County',
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
    {
      properties: {
        id: 'urn:oid:duplicated-air-quality',
        event: 'Air Quality Alert',
        headline: 'Air Quality Alert in effect',
        description: 'Smoke has degraded air quality.',
        instruction: 'Limit outdoor exertion.',
        severity: 'Moderate',
        urgency: 'Expected',
        certainty: 'Likely',
        areaDesc: 'Central Washington',
        sent: '2026-04-03T08:00:00-07:00',
        effective: '2026-04-03T08:00:00-07:00',
        onset: '2026-04-03T08:00:00-07:00',
        ends: '2026-04-04T08:00:00-07:00',
        expires: '2026-04-03T20:00:00-07:00',
        status: 'Actual',
        messageType: 'Alert',
        references: [],
        senderName: 'NWS Pendleton OR',
        affectedZones: ['https://api.weather.gov/zones/forecast/WAZ027'],
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

/** One upstream CAP reference entry, with the `@id` and `sender` keys NWS also sends. */
export function capReference(identifier: string, sent: string) {
  return {
    '@id': `https://api.weather.gov/alerts/${identifier}`,
    identifier,
    sender: 'w-nws.webmaster@noaa.gov',
    sent,
  };
}

/** Mock /alerts/active response for a single CAP Update carrying the given references. */
export function updateAlertWithReferences(references: ReturnType<typeof capReference>[]) {
  const base = updateAlertsResponse.features[0]!.properties;
  return { features: [{ properties: { ...base, references } }] };
}

/**
 * A CAP Update whose references NWS listed oldest first — upstream gives an update's
 * references in no fixed order (ascending, descending, and mixed all occur).
 */
export const ascendingReferencesAlertsResponse = updateAlertWithReferences([
  capReference('urn:oid:2.49.0.1.840.0.asc.001.1', '2026-10-16T00:15:00-05:00'),
  capReference('urn:oid:2.49.0.1.840.0.asc.002.1', '2026-10-16T00:33:00-05:00'),
  capReference('urn:oid:2.49.0.1.840.0.asc.003.1', '2026-10-16T01:08:00-05:00'),
]);

/** Empty alerts response */
export const emptyAlertsResponse = {
  features: [],
};

/** A current Freeze Warning Update, live on /alerts/active when captured (2026-10-16). */
export const CURRENT_ALERT_ID =
  'urn:oid:2.49.0.1.840.0.654087301e4bfcbe71d24494c26a965e54d3a1ad.001.1';

/** The Freeze Warning message CURRENT_ALERT_ID superseded — its newest reference. */
export const SUPERSEDED_ALERT_ID =
  'urn:oid:2.49.0.1.840.0.6f3f632c6cfd4c413dc7cc0b4f52b89a2535dc40.002.1';

/** A `Test`-status heartbeat NWS lists among active alerts, in its non-hash ID shape. */
export const KEEPALIVE_ALERT_ID = 'urn:oid:2.49.0.1.840.0-KEEPALIVE-29289';

/** Shared properties of the two Freeze Warning messages below. */
const freezeWarningBase = {
  areaDesc: 'Divide; Burke; Renville',
  affectedZones: [
    'https://api.weather.gov/zones/forecast/NDZ001',
    'https://api.weather.gov/zones/forecast/NDZ002',
    'https://api.weather.gov/zones/forecast/NDZ003',
  ],
  status: 'Actual',
  messageType: 'Update',
  category: 'Met',
  severity: 'Severe',
  certainty: 'Likely',
  urgency: 'Expected',
  event: 'Freeze Warning',
  sender: 'w-nws.webmaster@noaa.gov',
  senderName: 'NWS Bismarck ND',
  instruction: 'Take steps now to protect sensitive outdoor plants from the cold.',
  response: 'Execute',
  note: null,
  scope: 'Public',
  code: 'IPAWSv1.0',
  language: 'en-US',
  web: 'http://www.weather.gov',
  eventCode: { SAME: ['NWS'], NationalWeatherService: ['FZW'] },
};

/**
 * `/alerts/{CURRENT_ALERT_ID}` — the single GeoJSON Feature NWS answers with, trimmed
 * to three zones. Its references arrive oldest first, as captured.
 */
export const currentAlertFeature = {
  id: `https://api.weather.gov/alerts/${CURRENT_ALERT_ID}`,
  type: 'Feature',
  geometry: null,
  properties: {
    ...freezeWarningBase,
    '@id': `https://api.weather.gov/alerts/${CURRENT_ALERT_ID}`,
    '@type': 'wx:Alert',
    id: CURRENT_ALERT_ID,
    references: [
      capReference(
        'urn:oid:2.49.0.1.840.0.478df6166ade7585f4aed605340188fa5f655ff1.001.2',
        '2026-10-15T23:43:00-05:00',
      ),
      capReference(
        'urn:oid:2.49.0.1.840.0.478df6166ade7585f4aed605340188fa5f655ff1.002.1',
        '2026-10-15T23:43:00-05:00',
      ),
      capReference(SUPERSEDED_ALERT_ID, '2026-10-16T01:14:00-05:00'),
    ],
    sent: '2026-10-16T07:15:00-05:00',
    effective: '2026-10-16T07:15:00-05:00',
    onset: '2026-10-16T07:15:00-05:00',
    expires: '2026-10-16T10:00:00-05:00',
    ends: '2026-10-16T10:00:00-05:00',
    headline:
      'Freeze Warning issued October 16 at 7:15AM CDT until October 16 at 10:00AM CDT by NWS Bismarck ND',
    description:
      '* WHAT...Sub-freezing temperatures as low as 25 expected.\n\n* WHERE...Western and much of central North Dakota.\n\n* WHEN...Until 10 AM CDT /9 AM MDT/ this morning.',
  },
};

/**
 * `/alerts/{SUPERSEDED_ALERT_ID}` — a message no longer active, which NWS still
 * serves with `replacedBy`/`replacedAt` naming its successor.
 */
export const supersededAlertFeature = {
  id: `https://api.weather.gov/alerts/${SUPERSEDED_ALERT_ID}`,
  type: 'Feature',
  geometry: null,
  properties: {
    ...freezeWarningBase,
    '@id': `https://api.weather.gov/alerts/${SUPERSEDED_ALERT_ID}`,
    '@type': 'wx:Alert',
    id: SUPERSEDED_ALERT_ID,
    references: [
      capReference(
        'urn:oid:2.49.0.1.840.0.478df6166ade7585f4aed605340188fa5f655ff1.001.2',
        '2026-10-15T23:43:00-05:00',
      ),
      capReference(
        'urn:oid:2.49.0.1.840.0.478df6166ade7585f4aed605340188fa5f655ff1.002.1',
        '2026-10-15T23:43:00-05:00',
      ),
    ],
    replacedBy: `https://api.weather.gov/alerts/${CURRENT_ALERT_ID}`,
    replacedAt: '2026-10-16T07:15:00-05:00',
    sent: '2026-10-16T01:14:00-05:00',
    effective: '2026-10-16T01:14:00-05:00',
    onset: '2026-10-16T01:14:00-05:00',
    expires: '2026-10-16T08:00:00-05:00',
    ends: '2026-10-16T08:00:00-05:00',
    headline:
      'Freeze Warning issued October 16 at 1:14AM CDT until October 16 at 8:00AM CDT by NWS Bismarck ND',
    description:
      '* WHAT...Sub-freezing temperatures as low as 27.\n\n* WHERE...Western and much of central North Dakota.\n\n* WHEN...Until 8 AM CDT /7 AM MDT/ this morning.',
  },
};

/** `/alerts/{KEEPALIVE_ALERT_ID}` — sparse: null headline, onset, and ends; no references. */
export const keepaliveAlertFeature = {
  id: `https://api.weather.gov/alerts/${KEEPALIVE_ALERT_ID}`,
  type: 'Feature',
  geometry: null,
  properties: {
    '@id': `https://api.weather.gov/alerts/${KEEPALIVE_ALERT_ID}`,
    '@type': 'wx:Alert',
    id: KEEPALIVE_ALERT_ID,
    areaDesc: 'Montgomery',
    geocode: { SAME: ['024031'], UGC: ['MDC031'] },
    affectedZones: ['https://api.weather.gov/zones/county/MDC031'],
    references: [],
    sent: '2026-10-16T13:35:14+00:00',
    effective: '2026-10-16T13:35:14+00:00',
    onset: null,
    expires: '2026-10-16T13:45:14+00:00',
    ends: null,
    status: 'Test',
    messageType: 'Alert',
    category: 'Met',
    severity: 'Unknown',
    certainty: 'Unknown',
    urgency: 'Unknown',
    event: 'Test Message',
    sender: 'w-nws.webmaster@noaa.gov',
    senderName: 'NWS',
    headline: null,
    description: 'Monitoring message only. Please disregard.',
    instruction: 'Monitoring message only. Please disregard.',
  },
};

/**
 * The 404 `/alerts/{id}` returns, byte for byte, for an ID past NWS retention (this
 * one, sent 2026-08-12); a fabricated or case-changed ID gets the same problem.
 */
export const invalidAlertProblem = {
  correlationId: '3130e4fd',
  title: 'Alert Does Not Exist',
  type: 'https://api.weather.gov/problems/InvalidAlert',
  status: 404,
  detail:
    'Alert urn:oid:2.49.0.1.840.0.bdf719324e5ca7bfb4eaf558f9a6f22ccdc99157.001.1 does not exist',
  instance: 'https://api.weather.gov/requests/3130e4fd',
};

/** The aged-out, well-formed ID `invalidAlertProblem` answers. */
export const AGED_OUT_ALERT_ID =
  'urn:oid:2.49.0.1.840.0.bdf719324e5ca7bfb4eaf558f9a6f22ccdc99157.001.1';

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

/**
 * Mock /alerts/active/count response, shaped like the live one: a multi-area
 * alert counts in each area (areas sum past `total`), `land + marine = total`,
 * and region "AL" (Alaska waters) sits beside area "AL" (Alabama). `zones` is
 * the map the tool drops.
 */
export const alertCountsResponse = {
  total: 224,
  land: 124,
  marine: 100,
  regions: { AL: 73, GL: 10, GM: 2, PA: 13, PI: 2 },
  areas: { AK: 40, AL: 3, TX: 17, WA: 5, PZ: 13, LS: 10, GU: 2 },
  zones: { WAZ558: 2, WAC033: 1, AKZ101: 4 },
};

/** A land-only /alerts/active/count response: no marine alert, so `regions` is empty. */
export const landOnlyAlertCountsResponse = {
  total: 3,
  land: 3,
  marine: 0,
  regions: {},
  areas: { OK: 2, KS: 1 },
  zones: { OKZ025: 2, KSZ099: 1 },
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

/**
 * One feature of a /stations/{id}/observations collection. NWS addresses each
 * observation by station and timestamp, so the timestamp is the collection key.
 */
export function observationFeature(timestamp: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `https://api.weather.gov/stations/KSEA/observations/${timestamp}`,
    properties: { ...observationResponse.properties, timestamp, ...overrides },
  };
}

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

/**
 * Mock /points for a gridded marine cell (46.2,-124.1, Columbia River bar). NWS
 * tags the cell `type: "marine"` yet still hands back grid URLs; the gridpoint
 * forecast then answers 404 `MarineForecastNotSupported`, while stations and
 * observations keep working.
 */
export const griddedMarinePointsResponse = {
  properties: {
    type: 'marine',
    gridId: 'PQR',
    gridX: 74,
    gridY: 145,
    forecast: 'https://api.weather.gov/gridpoints/PQR/74,145/forecast',
    forecastHourly: 'https://api.weather.gov/gridpoints/PQR/74,145/forecast/hourly',
    observationStations: 'https://api.weather.gov/gridpoints/PQR/74,145/stations',
    relativeLocation: {
      properties: {
        city: 'Warrenton',
        state: 'OR',
      },
    },
    timeZone: 'America/Los_Angeles',
    forecastZone: 'https://api.weather.gov/zones/forecast/PZZ251',
    county: null,
  },
};

/**
 * Mock /points for an offshore marine point beyond the forecast grid (28,-90, Gulf).
 * HTTP 200 with every grid field null — there is no gridpoint URL to call.
 */
export const gridlessMarinePointsResponse = {
  properties: {
    cwa: 'NH2',
    type: 'marine',
    gridId: null,
    gridX: null,
    gridY: null,
    forecast: null,
    forecastHourly: null,
    forecastGridData: null,
    observationStations: null,
    relativeLocation: {
      properties: {
        city: 'Grand Isle',
        state: 'LA',
      },
    },
    forecastZone: 'https://api.weather.gov/zones/forecast/GMZ056',
    timeZone: 'America/Chicago',
  },
};

/**
 * Mock /points for a land point NWS serves no forecast grid for (18.1072,145.7669,
 * Pagan, Northern Mariana Islands). HTTP 200, `type: "land"`, every grid field
 * null, and a real forecast zone.
 */
export const gridlessLandPointsResponse = {
  properties: {
    type: 'land',
    gridId: null,
    gridX: null,
    gridY: null,
    forecast: null,
    forecastHourly: null,
    forecastGridData: null,
    observationStations: null,
    relativeLocation: {
      properties: {
        city: 'Pagan',
        state: 'MP',
      },
    },
    forecastZone: 'https://api.weather.gov/zones/forecast/MPZ006',
    county: 'https://api.weather.gov/zones/county/MPC085',
    timeZone: 'Pacific/Saipan',
  },
};

/** Build an NWS RFC 7807 problem document with the given `type` suffix and status. */
export function nwsProblem(type: string, status: number, detail: string) {
  return {
    type: `https://api.weather.gov/problems/${type}`,
    title: type,
    status,
    detail,
    instance: 'https://api.weather.gov/requests/0000abcd',
    correlationId: '0000abcd',
  };
}

/**
 * 404 NWS returns for a marine gridpoint forecast and for an offshore marine zone's
 * forecast. A coastal zone with no text forecast answers a generic `NotFound` instead.
 */
export const marineForecastNotSupportedProblem = nwsProblem(
  'MarineForecastNotSupported',
  404,
  'Forecasts for marine areas are not yet supported by this API.',
);

/** 404 for a zone code with a known state prefix that does not exist (e.g. WAZ999). */
export const invalidZoneProblem = nwsProblem(
  'InvalidZone',
  404,
  'forecast zone WAZ999 does not exist',
);

/**
 * 404 typed `NotFound`. NWS answers both a valid zone with no text product
 * (PRZ001) and a made-up zone with an unknown prefix (XXZ123) this way, so the
 * type alone cannot tell them apart.
 */
export const notFoundProblem = nwsProblem('NotFound', 404, 'Not Found');

/** 404 for a gridpoint outside the office grid (e.g. PQR/999,999). */
export const invalidGridpointProblem = nwsProblem(
  'InvalidGridpoint',
  404,
  'Requested gridpoint PQR:999,999 does not exist',
);

/** 404 /points returns for coordinates outside NWS coverage. */
export const invalidPointProblem = nwsProblem(
  'InvalidPoint',
  404,
  'Unable to provide data for requested point 51.5,-0.1',
);

/**
 * 400 `/alerts/active?point=` returns for an in-range point outside NWS coverage
 * (e.g. 10,10 or -47.6,-122.3), with the title NWS sends.
 */
export const outOfBoundsPointProblem = {
  ...nwsProblem('InvalidParameter', 400, 'Parameter "point" is invalid: out of bounds'),
  title: 'Invalid Parameter',
};

/**
 * 500 NWS returns on every attempt for some valid zones' forecast (e.g. AKZ829),
 * and for `/points` and `/alerts/active?point=` at some open-ocean points (e.g. 25,-70).
 */
export const unexpectedProblem = nwsProblem(
  'UnexpectedProblem',
  500,
  'An unexpected problem has occurred.',
);

/** Mock /zones/forecast/{id} zone record — the existence probe's 200 body, no geometry. */
export const zoneRecordResponse = {
  properties: {
    id: 'AKZ829',
    type: 'public',
    name: 'Middle Yukon Valley',
    state: 'AK',
  },
};

/** AKZ829's zone record with its real Polygon geometry (coordinates are [lon, lat]). */
export const polygonZoneRecordResponse = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-153.507534, 63.847892],
        [-157.720026, 63.879913],
        [-159.492733, 63.898375],
        [-159.737466, 63.90251],
        [-159.737475, 64.051459],
        [-159.947288, 64.051459],
        [-159.947325, 64.397925],
        [-159.962255, 64.397927],
        [-159.96229, 64.744377],
        [-159.774897, 64.744382],
        [-159.774921, 64.917565],
        [-159.572173, 64.917597],
        [-159.480043, 64.926351],
        [-157.68961, 64.975128],
        [-155.616212, 65.156961],
        [-153.727016, 65.396813],
        [-154.600123, 64.630013],
        [-154.000117, 64.330109],
        [-153.61825, 63.963449],
        [-153.507534, 63.847892],
      ],
    ],
  },
  properties: zoneRecordResponse.properties,
};

/**
 * Synthetic MultiPolygon zone record whose area centroid and bounding-box center
 * both fall outside the zone, as they do for AKZ801 and AKZ787. The large part is
 * a U open to the north (arms at lon -160..-158 and -152..-150, base at lat 60..62);
 * the small part is a square islet to the east.
 */
export const multiPolygonZoneRecordResponse = {
  type: 'Feature',
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [-140, 60],
          [-139, 60],
          [-139, 61],
          [-140, 61],
          [-140, 60],
        ],
      ],
      [
        [
          [-160, 60],
          [-150, 60],
          [-150, 70],
          [-152, 70],
          [-152, 62],
          [-158, 62],
          [-158, 70],
          [-160, 70],
          [-160, 60],
        ],
      ],
    ],
  },
  properties: { id: 'PRZ001', type: 'public', name: 'San Juan and Vicinity', state: 'PR' },
};

/** Zone record NWS serves with `geometry: null`. */
export const nullGeometryZoneRecordResponse = {
  type: 'Feature',
  geometry: null,
  properties: zoneRecordResponse.properties,
};

/**
 * LMZ645's zone record with its real geometry, captured 2026-10-16. Record `type`
 * `coastal` marks a nearshore marine zone; its `/forecast` answers 404 `NotFound`,
 * as every sampled Great Lakes, Guam, Samoa, and most Alaska coastal zones do,
 * while Atlantic, Gulf, Pacific, and Hawaii coastal zones (e.g. PZZ251) serve one.
 * The geometry's interior point is (42.9181, -87.799), in Lake Michigan.
 */
export const coastalZoneRecordResponse = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-87.783743, 43.052377],
        [-87.787346, 43.038143],
        [-87.791614, 43.031097],
        [-87.788747, 43.027742],
        [-87.783654, 43.018988],
        [-87.77894, 43.012485],
        [-87.768243, 42.993884],
        [-87.763037, 42.975706],
        [-87.762737, 42.973906],
        [-87.761993, 42.964913],
        [-87.761172, 42.961979],
        [-87.760372, 42.956779],
        [-87.759404, 42.944116],
        [-87.760144, 42.937481],
        [-87.756773, 42.924546],
        [-87.756573, 42.922846],
        [-87.756003, 42.913116],
        [-87.757063, 42.907784],
        [-87.75749, 42.901646],
        [-87.756807, 42.90119],
        [-87.75607, 42.900086],
        [-87.75506, 42.89939],
        [-87.729054, 42.871866],
        [-87.726273, 42.869703],
        [-87.723735, 42.868295],
        [-87.701687, 42.852554],
        [-87.699386, 42.850606],
        [-87.69811, 42.849852],
        [-87.695256, 42.847573],
        [-87.688334, 42.841384],
        [-87.670282, 42.814367],
        [-87.665364, 42.789645],
        [-87.747951, 42.78178],
        [-87.747223, 42.782497],
        [-87.750076, 42.784779],
        [-87.772141, 42.800529],
        [-87.781387, 42.806225],
        [-87.792397, 42.817554],
        [-87.815696, 42.842304],
        [-87.82649, 42.842227],
        [-87.827222, 42.843889],
        [-87.827578, 42.845317],
        [-87.824692, 42.846115],
        [-87.826393, 42.849213],
        [-87.829078, 42.848517],
        [-87.829979, 42.849316],
        [-87.834892, 42.856712],
        [-87.836189, 42.860714],
        [-87.837479, 42.864017],
        [-87.841171, 42.872238],
        [-87.843506, 42.877987],
        [-87.844279, 42.880617],
        [-87.845786, 42.883412],
        [-87.84259, 42.885014],
        [-87.842889, 42.888618],
        [-87.84778, 42.889216],
        [-87.848091, 42.893112],
        [-87.84768, 42.898716],
        [-87.846581, 42.900818],
        [-87.84578, 42.903816],
        [-87.844482, 42.905518],
        [-87.842682, 42.906418],
        [-87.840782, 42.906216],
        [-87.84008, 42.912416],
        [-87.83928, 42.913116],
        [-87.83948, 42.914816],
        [-87.84378, 42.921416],
        [-87.84578, 42.927416],
        [-87.845681, 42.930216],
        [-87.844582, 42.937115],
        [-87.843384, 42.941017],
        [-87.842682, 42.944115],
        [-87.843483, 42.949314],
        [-87.843582, 42.951515],
        [-87.845184, 42.954617],
        [-87.845383, 42.956116],
        [-87.844881, 42.957715],
        [-87.844881, 42.960215],
        [-87.845184, 42.962013],
        [-87.848381, 42.966213],
        [-87.855282, 42.976115],
        [-87.854485, 42.976616],
        [-87.855182, 42.977515],
        [-87.857185, 42.978016],
        [-87.862083, 42.981815],
        [-87.868682, 42.986315],
        [-87.871582, 42.987915],
        [-87.878685, 42.992416],
        [-87.882782, 42.996513],
        [-87.882385, 42.997116],
        [-87.882883, 42.997515],
        [-87.884383, 42.997615],
        [-87.887683, 43.000514],
        [-87.887085, 43.001114],
        [-87.888383, 43.002214],
        [-87.887886, 43.002613],
        [-87.888184, 43.002613],
        [-87.888383, 43.004214],
        [-87.889183, 43.004814],
        [-87.890587, 43.004112],
        [-87.895784, 43.015814],
        [-87.893288, 43.017914],
        [-87.894083, 43.019412],
        [-87.896484, 43.017414],
        [-87.896784, 43.018214],
        [-87.894485, 43.020313],
        [-87.894983, 43.021212],
        [-87.897285, 43.019413],
        [-87.897484, 43.020016],
        [-87.895287, 43.021915],
        [-87.895984, 43.024714],
        [-87.899086, 43.024414],
        [-87.899284, 43.025013],
        [-87.899384, 43.025616],
        [-87.896289, 43.025715],
        [-87.896194, 43.028637],
        [-87.894928, 43.029621],
        [-87.894249, 43.031212],
        [-87.894434, 43.032103],
        [-87.894722, 43.032642],
        [-87.896133, 43.033882],
        [-87.896338, 43.033806],
        [-87.896072, 43.033497],
        [-87.897079, 43.032932],
        [-87.89729, 43.032643],
        [-87.897156, 43.031773],
        [-87.896206, 43.031405],
        [-87.895911, 43.031076],
        [-87.895703, 43.030378],
        [-87.895889, 43.02935],
        [-87.896492, 43.0289],
        [-87.897346, 43.028866],
        [-87.898224, 43.029621],
        [-87.89834, 43.030468],
        [-87.897087, 43.036514],
        [-87.895386, 43.036613],
        [-87.895287, 43.038113],
        [-87.896684, 43.038113],
        [-87.896385, 43.039211],
        [-87.895084, 43.042313],
        [-87.890685, 43.042313],
        [-87.887384, 43.043313],
        [-87.884186, 43.045815],
        [-87.881884, 43.045914],
        [-87.881784, 43.046112],
        [-87.886581, 43.046013],
        [-87.888184, 43.044613],
        [-87.890084, 43.045713],
        [-87.888985, 43.046814],
        [-87.888885, 43.047314],
        [-87.889885, 43.048115],
        [-87.887484, 43.050313],
        [-87.887734, 43.050413],
        [-87.886784, 43.051513],
        [-87.885681, 43.051064],
        [-87.885583, 43.050813],
        [-87.883984, 43.051113],
        [-87.883881, 43.050614],
        [-87.882084, 43.051113],
        [-87.882447, 43.0518],
        [-87.783743, 43.052377],
      ],
    ],
  },
  properties: {
    id: 'LMZ645',
    type: 'coastal',
    name: 'North Point Light to Wind Point WI',
    state: null,
  },
};

/**
 * GMZ056's zone record properties, captured 2026-10-16 (geometry omitted). Record
 * `type` `offshore` marks an open-water marine zone; every sampled offshore zone's
 * `/forecast` answers 404 `MarineForecastNotSupported`.
 */
export const offshoreZoneRecordResponse = {
  properties: {
    id: 'GMZ056',
    type: 'offshore',
    name: 'N Central Gulf of America Offshore Waters',
    state: null,
  },
};

/** PZZ251's `/forecast`, captured 2026-10-16 (first two of ten periods): a coastal zone that serves one. */
export const coastalZoneForecastResponse = {
  properties: {
    updated: '2026-10-16T01:33:00-07:00',
    periods: [
      {
        number: 1,
        name: 'Today',
        detailedForecast:
          'W wind around 5 kt. Seas 3 to 5 ft. Wave Detail: W 5 ft at 12 seconds and SW 2 ft at 15 seconds. Areas of dense fog late this morning. Patchy fog early this afternoon.',
      },
      {
        number: 2,
        name: 'Tonight',
        detailedForecast:
          'SW wind 5 to 10 kt, rising to 10 to 15 kt after midnight. Seas 5 to 7 ft. Wave Detail: SW 2 ft at 4 seconds, W 6 ft at 11 seconds and SW 2 ft at 15 seconds. A slight chance of rain in the evening, then rain likely after midnight.',
      },
    ],
  },
};

/** Mock /zones/forecast/{id}/forecast response. */
export const zoneForecastResponse = {
  properties: {
    updated: '2026-09-24T14:36:00-07:00',
    periods: [
      {
        number: 1,
        name: 'Today',
        detailedForecast: 'Mostly cloudy. Highs in the lower 60s.',
      },
      {
        number: 2,
        name: 'Tonight',
        detailedForecast: 'Rain likely. Lows in the upper 40s.',
      },
    ],
  },
};
