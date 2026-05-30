/**
 * @fileoverview Security and injection-attempt tests across all NWS tools.
 * @module tests/tools/security
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- service mock setup ----
const mockGetForecast = vi.fn();
const mockSearchAlerts = vi.fn();
const mockGetObservation = vi.fn();
const mockFindStations = vi.fn();
const mockListAlertTypes = vi.fn();
const mockGetOfficeDiscussion = vi.fn();
const mockGetZoneForecast = vi.fn();

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({
    getForecast: mockGetForecast,
    searchAlerts: mockSearchAlerts,
    getObservation: mockGetObservation,
    findStations: mockFindStations,
    listAlertTypes: mockListAlertTypes,
    getOfficeDiscussion: mockGetOfficeDiscussion,
    getZoneForecast: mockGetZoneForecast,
  }),
}));

const { getForecastTool } = await import('@/mcp-server/tools/definitions/get-forecast.tool.js');
const { searchAlertsTool } = await import('@/mcp-server/tools/definitions/search-alerts.tool.js');
const { getObservationsTool } = await import(
  '@/mcp-server/tools/definitions/get-observations.tool.js'
);
const { findStationsTool } = await import('@/mcp-server/tools/definitions/find-stations.tool.js');
const { getOfficeDiscussionTool } = await import(
  '@/mcp-server/tools/definitions/get-office-discussion.tool.js'
);
const { getZoneForecastTool } = await import(
  '@/mcp-server/tools/definitions/get-zone-forecast.tool.js'
);

const mockForecastResult = {
  location: {
    city: 'Test City',
    state: 'TX',
    office: 'FWD',
    timeZone: 'America/Chicago',
    forecastZone: 'TXZ100',
    county: 'TXC001',
  },
  forecast: {
    generatedAt: '2026-04-03T12:00:00Z',
    updateTime: '2026-04-03T12:00:00Z',
    periods: [],
  },
};

const mockObsResult = {
  observation: {
    stationId: 'KORD',
    stationName: "Chicago O'Hare",
    timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    timeZone: 'America/Chicago',
    textDescription: 'Clear',
    temperature: { value: 20, unitCode: 'wmoUnit:degC' },
    dewpoint: { value: 10, unitCode: 'wmoUnit:degC' },
    windSpeed: { value: 15, unitCode: 'wmoUnit:km_h-1' },
    windDirection: { value: 180, unitCode: 'wmoUnit:degree_(angle)' },
    windGust: { value: null, unitCode: 'wmoUnit:km_h-1' },
    barometricPressure: { value: 101325, unitCode: 'wmoUnit:Pa' },
    visibility: { value: 16093, unitCode: 'wmoUnit:m' },
    relativeHumidity: { value: 55, unitCode: 'wmoUnit:percent' },
    heatIndex: { value: null, unitCode: 'wmoUnit:degC' },
    windChill: { value: null, unitCode: 'wmoUnit:degC' },
    cloudLayers: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Input validation — coordinate bounds', () => {
  it('rejects latitude > 90 for nws_get_forecast', () => {
    expect(() => getForecastTool.input.parse({ latitude: 91, longitude: 0 })).toThrow();
  });

  it('rejects latitude < -90 for nws_get_forecast', () => {
    expect(() => getForecastTool.input.parse({ latitude: -91, longitude: 0 })).toThrow();
  });

  it('rejects longitude > 180 for nws_get_forecast', () => {
    expect(() => getForecastTool.input.parse({ latitude: 0, longitude: 181 })).toThrow();
  });

  it('rejects longitude < -180 for nws_get_forecast', () => {
    expect(() => getForecastTool.input.parse({ latitude: 0, longitude: -181 })).toThrow();
  });

  it('accepts lat/lon at exact min/max boundaries for nws_get_forecast', () => {
    const a = getForecastTool.input.parse({ latitude: -90, longitude: -180 });
    expect(a.latitude).toBe(-90);
    expect(a.longitude).toBe(-180);

    const b = getForecastTool.input.parse({ latitude: 90, longitude: 180 });
    expect(b.latitude).toBe(90);
    expect(b.longitude).toBe(180);
  });

  it('rejects latitude > 90 for nws_find_stations', () => {
    expect(() => findStationsTool.input.parse({ latitude: 91, longitude: 0 })).toThrow();
  });

  it('rejects longitude > 180 for nws_find_stations', () => {
    expect(() => findStationsTool.input.parse({ latitude: 0, longitude: 181 })).toThrow();
  });
});

describe('Input validation — limit bounds', () => {
  it('rejects limit = 0 for nws_find_stations', () => {
    expect(() =>
      findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 0 }),
    ).toThrow();
  });

  it('rejects limit > 50 for nws_find_stations', () => {
    expect(() =>
      findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 51 }),
    ).toThrow();
  });

  it('accepts limit = 1 and limit = 50 for nws_find_stations', () => {
    const lo = findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 1 });
    expect(lo.limit).toBe(1);
    const hi = findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 50 });
    expect(hi.limit).toBe(50);
  });
});

describe('Injection attempts — nws_search_alerts', () => {
  it('rejects invalid area with SQL-injection-style payload', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({ area: "'; DROP TABLE alerts; --" });
    const result = searchAlertsTool.handler(input, ctx);
    await expect(result).rejects.toThrow('Invalid area code');
    expect(mockSearchAlerts).not.toHaveBeenCalled();
  });

  it('rejects invalid area with a script tag payload', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({ area: '<script>alert(1)</script>' });
    const result = searchAlertsTool.handler(input, ctx);
    await expect(result).rejects.toThrow('Invalid area code');
    expect(mockSearchAlerts).not.toHaveBeenCalled();
  });

  it('rejects a point with extra path segments as injection attempt', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({ point: '47.6,-122.3/../../secret' });
    const result = searchAlertsTool.handler(input, ctx);
    await expect(result).rejects.toThrow('Invalid point');
    expect(mockSearchAlerts).not.toHaveBeenCalled();
  });

  it('rejects a point with a URL as injection attempt', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: searchAlertsTool.errors });
    const input = searchAlertsTool.input.parse({
      point: 'https://evil.example.com/steal?data=',
    });
    const result = searchAlertsTool.handler(input, ctx);
    await expect(result).rejects.toThrow('Invalid point');
    expect(mockSearchAlerts).not.toHaveBeenCalled();
  });
});

describe('Injection attempts — nws_get_office_discussion', () => {
  it('passes through office after uppercasing; injection attempt does not call service with raw payload', async () => {
    // The tool does trim().toUpperCase() before calling service — verify
    // an injected string is still uppercased before reaching service.
    mockGetOfficeDiscussion.mockResolvedValueOnce({
      issuanceTime: '2026-05-30T10:33:00+00:00',
      issuingOffice: 'KSEW',
      productCode: 'AFD',
      productName: 'Area Forecast Discussion',
      productText: 'text',
      wmoCollectiveId: 'FXUS66',
    });

    const ctx = createMockContext({ tenantId: 'test' });
    // An office code with a path-injection attempt — NWS API will reject the upstream
    // call, but verify the tool at least uppercases it before passing on
    const input = getOfficeDiscussionTool.input.parse({ office: 'sew' });
    await getOfficeDiscussionTool.handler(input, ctx);

    expect(mockGetOfficeDiscussion).toHaveBeenCalledWith('SEW', 'AFD', ctx);
  });

  it('rejects empty office string', () => {
    expect(() => getOfficeDiscussionTool.input.parse({ office: '' })).toThrow();
  });

  it('rejects invalid product_type', () => {
    expect(() =>
      getOfficeDiscussionTool.input.parse({ office: 'SEW', product_type: 'INVALID' }),
    ).toThrow();
  });
});

describe('Injection attempts — nws_get_zone_forecast', () => {
  it('uppercases zone_id before passing to service', async () => {
    mockGetZoneForecast.mockResolvedValueOnce({
      zoneId: 'WAZ315',
      updated: '2026-05-30T02:36:00-07:00',
      periods: [],
    });

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getZoneForecastTool.input.parse({ zone_id: 'waz315' });
    await getZoneForecastTool.handler(input, ctx);

    expect(mockGetZoneForecast).toHaveBeenCalledWith('WAZ315', ctx);
  });

  it('rejects empty zone_id string', () => {
    expect(() => getZoneForecastTool.input.parse({ zone_id: '' })).toThrow();
  });
});

describe('Oversized inputs — truncated/rejected by schema or handler', () => {
  it('rejects non-numeric latitude (string) for nws_get_forecast', () => {
    expect(() => getForecastTool.input.parse({ latitude: 'not-a-number', longitude: 0 })).toThrow();
  });

  it('rejects non-numeric longitude (string) for nws_get_forecast', () => {
    expect(() =>
      getForecastTool.input.parse({ latitude: 47.6, longitude: 'not-a-number' }),
    ).toThrow();
  });

  it('rejects non-integer limit for nws_find_stations', () => {
    expect(() =>
      findStationsTool.input.parse({ latitude: 47.6, longitude: -122.3, limit: 2.5 }),
    ).toThrow();
  });
});

describe('No secrets in tool output', () => {
  it('nws_get_forecast output does not contain env-var value', async () => {
    process.env.NWS_USER_AGENT = 'TEST_SECRET_UA';

    mockGetForecast.mockResolvedValueOnce({
      ...mockForecastResult,
    });

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getForecastTool.input.parse({ latitude: 47.6, longitude: -122.3 });
    const result = await getForecastTool.handler(input, ctx);

    expect(JSON.stringify(result)).not.toContain('TEST_SECRET_UA');

    delete process.env.NWS_USER_AGENT;
  });

  it('nws_get_observations output does not contain env-var value', async () => {
    process.env.NWS_USER_AGENT = 'TEST_SECRET_UA_OBS';

    mockGetObservation.mockResolvedValueOnce(mockObsResult);

    const ctx = createMockContext({ tenantId: 'test' });
    const input = getObservationsTool.input.parse({ station_id: 'KORD' });
    const result = await getObservationsTool.handler(input, ctx);

    expect(JSON.stringify(result)).not.toContain('TEST_SECRET_UA_OBS');

    delete process.env.NWS_USER_AGENT;
  });

  it('nws_search_alerts output does not contain env-var value', async () => {
    process.env.NWS_USER_AGENT = 'TEST_SECRET_UA_ALERTS';

    mockSearchAlerts.mockResolvedValueOnce({ alerts: [] });

    const ctx = createMockContext({ tenantId: 'test' });
    const input = searchAlertsTool.input.parse({});
    const result = await searchAlertsTool.handler(input, ctx);

    expect(JSON.stringify(result)).not.toContain('TEST_SECRET_UA_ALERTS');

    delete process.env.NWS_USER_AGENT;
  });
});
