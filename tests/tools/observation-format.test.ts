/**
 * @fileoverview Additional format() tests for nws_get_observations: unit conversions,
 * edge cases, sparse payloads, heat index, wind chill, limited-data notice.
 * @module tests/tools/observation-format
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({}),
}));

const { getObservationsTool } = await import(
  '@/mcp-server/tools/definitions/get-observations.tool.js'
);

/** Helper: call format() with a minimal observation, allowing field overrides. */
function fmt(overrides: Partial<Parameters<typeof getObservationsTool.format>[0]> = {}) {
  const base: Parameters<typeof getObservationsTool.format>[0] = {
    stationId: 'KSEA',
    stationName: 'Seattle-Tacoma Intl',
    timestamp: '2026-04-03T11:53:00+00:00',
    timeZone: 'America/Los_Angeles',
    textDescription: 'Partly Cloudy',
    temperatureC: 15,
    dewpointC: 8,
    windSpeedKmh: 20,
    windDirectionDeg: 270,
    windGustKmh: null,
    barometricPressurePa: 101325,
    visibilityM: 16000,
    relativeHumidityPct: 60,
    heatIndexC: null,
    windChillC: null,
    cloudLayers: [],
  };
  return getObservationsTool.format!({ ...base, ...overrides });
}

function text(overrides: Partial<Parameters<typeof getObservationsTool.format>[0]> = {}) {
  const blocks = fmt(overrides);
  return (blocks[0] as { type: 'text'; text: string }).text;
}

describe('nws_get_observations format() — unit conversions', () => {
  it('renders temperature with both F and C', () => {
    // 15°C = 59°F
    const t = text({ temperatureC: 15 });
    expect(t).toContain('59°F');
    expect(t).toContain('15°C');
  });

  it('renders dewpoint in both F and C', () => {
    // 8°C = 46°F
    const t = text({ dewpointC: 8 });
    expect(t).toContain('46°F');
    expect(t).toContain('8°C');
  });

  it('renders wind speed with both mph and km/h', () => {
    // 20 km/h ≈ 12 mph
    const t = text({ windSpeedKmh: 20, windDirectionDeg: 270, windGustKmh: null });
    expect(t).toContain('mph');
    expect(t).toContain('km/h');
  });

  it('renders wind gust when present', () => {
    const t = text({ windSpeedKmh: 30, windDirectionDeg: 270, windGustKmh: 50 });
    expect(t).toContain('gusts');
  });

  it('renders "Calm" when wind speed is 0 and no gust', () => {
    const t = text({ windSpeedKmh: 0, windDirectionDeg: 0, windGustKmh: null });
    expect(t).toContain('Calm');
  });

  it('renders "Not available" when wind speed is null', () => {
    const t = text({ windSpeedKmh: null, windDirectionDeg: null, windGustKmh: null });
    expect(t).toContain('Not available');
  });

  it('renders pressure in inHg and hPa', () => {
    // 101325 Pa = 29.92 inHg = 1013 hPa
    const t = text({ barometricPressurePa: 101325 });
    expect(t).toContain('inHg');
    expect(t).toContain('hPa');
  });

  it('renders visibility in mi and km', () => {
    const t = text({ visibilityM: 16093 });
    expect(t).toContain('mi');
    expect(t).toContain('km');
  });

  it('renders humidity percent when present', () => {
    const t = text({ relativeHumidityPct: 73 });
    expect(t).toContain('73%');
  });
});

describe('nws_get_observations format() — heat index and wind chill', () => {
  it('renders heat index when present', () => {
    // 35°C = 95°F
    const t = text({ heatIndexC: 35 });
    expect(t).toContain('Heat Index');
    expect(t).toContain('95°F');
    expect(t).toContain('35°C');
  });

  it('does not render heat index section when null', () => {
    const t = text({ heatIndexC: null });
    expect(t).not.toContain('Heat Index');
  });

  it('renders wind chill when present', () => {
    // -10°C = 14°F
    const t = text({ windChillC: -10 });
    expect(t).toContain('Wind Chill');
    expect(t).toContain('14°F');
    expect(t).toContain('-10°C');
  });

  it('does not render wind chill section when null', () => {
    const t = text({ windChillC: null });
    expect(t).not.toContain('Wind Chill');
  });
});

describe('nws_get_observations format() — cloud layers', () => {
  it('renders cloud layers with amount and base height in m and ft', () => {
    const t = text({
      cloudLayers: [{ amount: 'BKN', baseM: 1524 }],
    });
    expect(t).toContain('BKN');
    expect(t).toContain('1524m');
    expect(t).toContain('ft');
  });

  it('renders cloud layer with null base height gracefully', () => {
    const t = text({
      cloudLayers: [{ amount: 'OVC', baseM: null }],
    });
    expect(t).toContain('OVC');
    // No crash when base is null
  });

  it('renders multiple cloud layers', () => {
    const t = text({
      cloudLayers: [
        { amount: 'FEW', baseM: 300 },
        { amount: 'SCT', baseM: 900 },
        { amount: 'BKN', baseM: 2100 },
      ],
    });
    expect(t).toContain('FEW');
    expect(t).toContain('SCT');
    expect(t).toContain('BKN');
  });

  it('skips cloud section when no layers', () => {
    const t = text({ cloudLayers: [] });
    expect(t).not.toContain('Clouds:');
  });
});

describe('nws_get_observations format() — sparse payloads', () => {
  it('shows limited-data notice when most measurements are null', () => {
    const t = text({
      temperatureC: null,
      dewpointC: null,
      windSpeedKmh: null,
      barometricPressurePa: null,
      visibilityM: null,
      relativeHumidityPct: null,
      heatIndexC: null,
      windChillC: null,
      cloudLayers: [],
    });
    expect(t).toContain('Limited data');
  });

  it('does not show limited-data notice when most measurements are present', () => {
    const t = text({
      temperatureC: 15,
      dewpointC: 8,
      windSpeedKmh: 20,
      barometricPressurePa: 101325,
      visibilityM: 16093,
      relativeHumidityPct: 60,
    });
    expect(t).not.toContain('Limited data');
  });

  it('shows station name and ID in heading even when data is sparse', () => {
    const t = text({
      stationId: 'KZZZ',
      stationName: 'Test Station',
      temperatureC: null,
      dewpointC: null,
      windSpeedKmh: null,
      barometricPressurePa: null,
      visibilityM: null,
      relativeHumidityPct: null,
    });
    expect(t).toContain('KZZZ');
    expect(t).toContain('Test Station');
  });

  it('renders gracefully with null timeZone', () => {
    const blocks = getObservationsTool.format!({
      stationId: 'KTEST',
      stationName: 'Unknown TZ Station',
      timestamp: '2026-04-03T11:53:00+00:00',
      timeZone: null,
      textDescription: 'Fair',
      temperatureC: 20,
      dewpointC: 10,
      windSpeedKmh: 15,
      windDirectionDeg: 90,
      windGustKmh: null,
      barometricPressurePa: 101000,
      visibilityM: 10000,
      relativeHumidityPct: 55,
      heatIndexC: null,
      windChillC: null,
      cloudLayers: [],
    });
    const t = (blocks[0] as { type: 'text'; text: string }).text;
    expect(t).toContain('KTEST');
    // should render without crashing
  });
});
