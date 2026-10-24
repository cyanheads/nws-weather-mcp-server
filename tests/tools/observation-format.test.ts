/**
 * @fileoverview Additional format() tests for nws_get_observations: unit conversions,
 * edge cases, sparse payloads, heat index, wind chill, limited-data notice.
 * @module tests/tools/observation-format
 */

import { describe, expect, it, vi } from 'vitest';
import { formatTimestamp } from '@/mcp-server/tools/format-utils.js';

vi.mock('@/services/nws/nws-service.js', () => ({
  getNwsService: () => ({}),
}));

const { getObservationsTool } = await import(
  '@/mcp-server/tools/definitions/get-observations.tool.js'
);

/** Helper: call format() with a minimal observation, allowing field overrides. */
function fmt(
  overrides: Partial<Parameters<NonNullable<typeof getObservationsTool.format>>[0]> = {},
) {
  const base: Parameters<NonNullable<typeof getObservationsTool.format>>[0] = {
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
    precipitationLastHourMm: null,
    precipitationLast3HoursMm: null,
    precipitationLast6HoursMm: null,
    cloudLayers: [],
  };
  return getObservationsTool.format!({ ...base, ...overrides });
}

function text(
  overrides: Partial<Parameters<NonNullable<typeof getObservationsTool.format>>[0]> = {},
) {
  const blocks = fmt(overrides);
  return (blocks[0] as { type: 'text'; text: string }).text;
}

describe('nws_get_observations format() — unit conversions', () => {
  it('escapes upstream station names, conditions, and cloud labels as literal text', () => {
    const t = text({
      stationName: 'A *station* [west]',
      textDescription: 'Rain *heavy* [nearby]',
      cloudLayers: [{ amount: '*BKN*', baseM: 500 }],
    });
    expect(t).toContain('## Current Conditions — A \\*station\\* \\[west\\] (KSEA)');
    expect(t).toContain('**Rain \\*heavy\\* \\[nearby\\]**');
    expect(t).toContain('**Clouds:** \\*BKN\\* at 500m (1640 ft)');
  });

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

  it('renders °C at one decimal and derives °F from that value (issue #64)', () => {
    // KPDX 2026-10-23T06:53Z after one-decimal rounding: 8.3 / 3.3 / wind chill 7.7.
    const t = text({ temperatureC: 8.3, dewpointC: 3.3, windChillC: 7.7 });
    expect(t).toContain('**Temperature:** 47°F (8.3°C)');
    expect(t).toContain('**Dewpoint:** 38°F (3.3°C)');
    expect(t).toContain('**Wind Chill:** 46°F (7.7°C)');
  });

  it('renders a whole degree without .0 and a negative tenth signed', () => {
    const t = text({ temperatureC: 17, dewpointC: -0.4 });
    expect(t).toContain('**Temperature:** 63°F (17°C)');
    expect(t).toContain('**Dewpoint:** 31°F (-0.4°C)');
    expect(t).not.toContain('.0°C');
  });

  it('renders a one-decimal heat index with °F from the shown °C', () => {
    // 24.2°C → 75.56°F → 76°F (the raw 24.151 would give 75°F).
    const t = text({ heatIndexC: 24.2 });
    expect(t).toContain('**Heat Index:** 76°F (24.2°C)');
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

  it('renders "Not available" when no wind component is reported', () => {
    const t = text({ windSpeedKmh: null, windDirectionDeg: null, windGustKmh: null });
    expect(t).toContain('**Wind:** Not available');
  });

  it('renders a reported gust when sustained speed is null (issue #61)', () => {
    // KDEN 2026-10-23T04:25Z: windSpeed and windDirection null, windGust 44.46 km/h.
    const t = text({ windSpeedKmh: null, windDirectionDeg: null, windGustKmh: 44 });
    expect(t).toContain('**Wind:** sustained not reported, gusts 27 mph (44 km/h)');
    expect(t).not.toContain('Not available');
  });

  it('renders direction and gust when sustained speed is null', () => {
    const t = text({ windSpeedKmh: null, windDirectionDeg: 350, windGustKmh: 44 });
    expect(t).toContain('**Wind:** 350°, sustained not reported, gusts 27 mph (44 km/h)');
  });

  it('renders a reported direction when sustained speed and gust are null', () => {
    const t = text({ windSpeedKmh: null, windDirectionDeg: 180, windGustKmh: null });
    expect(t).toContain('**Wind:** 180°, sustained not reported\n');
    expect(t).not.toContain('Not available');
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

describe('nws_get_observations format() — textDescription', () => {
  it('renders the bold conditions summary when present', () => {
    const t = text({ textDescription: 'Mostly Cloudy' });
    expect(t).toContain('**Mostly Cloudy**');
  });

  it('omits the bold segment and renders no **** when textDescription is empty', () => {
    const t = text({ textDescription: '' });
    expect(t).not.toContain('****');
    expect(t).not.toMatch(/\*\*\s*\*\*/);
    expect(t).toContain('Observed:');
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

describe('nws_get_observations format() — precipitation (issue #65)', () => {
  it('renders each reported amount in inches to two decimals beside mm', () => {
    const t = text({
      precipitationLastHourMm: 2.5,
      precipitationLast3HoursMm: null,
      precipitationLast6HoursMm: 11.2,
    });
    // 2.5 mm = 0.098 in → 0.10 in (METAR P0010); 11.2 mm = 0.441 in → 0.44 in (60044).
    expect(t).toContain('**Precipitation:** 1 h: 0.10 in (2.5 mm), 6 h: 0.44 in (11.2 mm)');
  });

  it('renders a 0 amount as a trace, not a dry hour', () => {
    const t = text({ precipitationLastHourMm: 0, precipitationLast6HoursMm: 0 });
    expect(t).toContain('**Precipitation:** 1 h: Trace, 6 h: Trace');
    expect(t).not.toContain('0 mm');
  });

  it('omits the Precipitation line when no amount was reported', () => {
    const t = text({
      precipitationLastHourMm: null,
      precipitationLast3HoursMm: null,
      precipitationLast6HoursMm: null,
    });
    expect(t).not.toContain('Precipitation');
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
  it('leaves limited-data notices to handler enrichment when measurements are null', () => {
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
    expect(t).not.toContain('Limited data');
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
      precipitationLastHourMm: null,
      precipitationLast3HoursMm: null,
      precipitationLast6HoursMm: null,
      cloudLayers: [],
    });
    const t = (blocks[0] as { type: 'text'; text: string }).text;
    expect(t).toContain('KTEST');
    // should render without crashing
  });
});

/**
 * Whole-output pins. The unit converters and dual-unit formatters this tool
 * renders with are shared with nws_get_observation_history, so the exact text
 * is fixed here: a change to a shared helper that moves one character of this
 * tool's output fails these, not just the substring checks above.
 *
 * The one exception is the observation time. `formatTimestamp` renders through
 * `toLocaleString`, whose ICU data differs by runtime (Node writes "Wed, Sep 30,
 * 5:00 AM", Bun "Wed, Sep 30 at 5:00 AM"), so its output is swapped for a marker
 * and every other byte is pinned.
 */
function pinned(
  overrides: Partial<Parameters<NonNullable<typeof getObservationsTool.format>>[0]> = {},
) {
  const timestamp = overrides.timestamp ?? '2026-04-03T11:53:00+00:00';
  const timeZone = overrides.timeZone === undefined ? 'America/Los_Angeles' : overrides.timeZone;
  return text(overrides).replace(formatTimestamp(timestamp, timeZone), '<observed>');
}

describe('nws_get_observations format() — exact output', () => {
  it('pins a full report with gusts, heat index, and cloud layers', () => {
    expect(
      pinned({
        temperatureC: 31.6,
        dewpointC: 21.2,
        windSpeedKmh: 24.1,
        windDirectionDeg: 225.4,
        windGustKmh: 40.7,
        barometricPressurePa: 101693.25,
        visibilityM: 16093.44,
        relativeHumidityPct: 54.4,
        heatIndexC: 34.8,
        cloudLayers: [
          { amount: 'FEW', baseM: 610 },
          { amount: 'BKN', baseM: 1524.123 },
          { amount: 'OVC', baseM: null },
        ],
      }),
    ).toMatchInlineSnapshot(`
      "## Current Conditions — Seattle-Tacoma Intl (KSEA)
      **Partly Cloudy** | Observed: <observed> (America/Los_Angeles)

      **Temperature:** 89°F (31.6°C)
      **Dewpoint:** 70°F (21.2°C)
      **Humidity:** 54%
      **Wind:** 225° 15 mph (24 km/h), gusts 25 mph (41 km/h)
      **Pressure:** 30.03 inHg (1017 hPa, 101693 Pa)
      **Visibility:** 10 mi (16.1 km, 16093 m)
      **Heat Index:** 95°F (34.8°C)
      **Clouds:** FEW at 610m (2001 ft), BKN at 1524m (5000 ft), OVC"
    `);
  });

  it('pins a calm, cold report with wind chill and an offset-only timestamp', () => {
    expect(
      pinned({
        timeZone: null,
        timestamp: '2026-01-15T06:53:00-05:00',
        textDescription: 'Clear',
        temperatureC: -12.2,
        dewpointC: -18.3,
        windSpeedKmh: 0,
        windDirectionDeg: null,
        windGustKmh: null,
        barometricPressurePa: 103050,
        visibilityM: 402.3,
        relativeHumidityPct: 60,
        windChillC: -19.7,
      }),
    ).toMatchInlineSnapshot(`
      "## Current Conditions — Seattle-Tacoma Intl (KSEA)
      **Clear** | Observed: <observed>

      **Temperature:** 10°F (-12.2°C)
      **Dewpoint:** -1°F (-18.3°C)
      **Humidity:** 60%
      **Wind:** Calm
      **Pressure:** 30.43 inHg (1031 hPa, 103050 Pa)
      **Visibility:** 0.2 mi (0.4 km, 402 m)
      **Wind Chill:** -3°F (-19.7°C)"
    `);
  });

  it('pins a sparse report whose notice is carried by enrichment', () => {
    expect(
      pinned({
        textDescription: '',
        temperatureC: 8,
        dewpointC: null,
        windSpeedKmh: null,
        windDirectionDeg: 180,
        windGustKmh: null,
        barometricPressurePa: null,
        visibilityM: null,
        relativeHumidityPct: null,
      }),
    ).toMatchInlineSnapshot(`
      "## Current Conditions — Seattle-Tacoma Intl (KSEA)
      Observed: <observed> (America/Los_Angeles)

      **Temperature:** 46°F (8°C)
      **Wind:** 180°, sustained not reported"
    `);
  });

  it('pins a rainy hourly report with precipitation amounts', () => {
    // KSLC 2026-10-23T02:54Z: `14008KT 8SM -RA … 13/12 … P0013 60024 T01330122`.
    expect(
      pinned({
        textDescription: 'Light Rain',
        temperatureC: 13.3,
        dewpointC: 12.2,
        windSpeedKmh: 15,
        windDirectionDeg: 140,
        relativeHumidityPct: 93,
        precipitationLastHourMm: 3.3,
        precipitationLast3HoursMm: 6.1,
        cloudLayers: [{ amount: 'SCT', baseM: 1250 }],
      }),
    ).toMatchInlineSnapshot(`
      "## Current Conditions — Seattle-Tacoma Intl (KSEA)
      **Light Rain** | Observed: <observed> (America/Los_Angeles)

      **Temperature:** 56°F (13.3°C)
      **Dewpoint:** 54°F (12.2°C)
      **Humidity:** 93%
      **Wind:** 140° 9 mph (15 km/h)
      **Pressure:** 29.92 inHg (1013 hPa, 101325 Pa)
      **Visibility:** 9.9 mi (16 km, 16000 m)
      **Precipitation:** 1 h: 0.13 in (3.3 mm), 3 h: 0.24 in (6.1 mm)
      **Clouds:** SCT at 1250m (4101 ft)"
    `);
  });

  it('pins a wind report with direction and no gust', () => {
    expect(
      pinned({ windSpeedKmh: 11.1, windDirectionDeg: 359.6, windGustKmh: null }),
    ).toMatchInlineSnapshot(`
      "## Current Conditions — Seattle-Tacoma Intl (KSEA)
      **Partly Cloudy** | Observed: <observed> (America/Los_Angeles)

      **Temperature:** 59°F (15°C)
      **Dewpoint:** 46°F (8°C)
      **Humidity:** 60%
      **Wind:** 360° 7 mph (11 km/h)
      **Pressure:** 29.92 inHg (1013 hPa, 101325 Pa)
      **Visibility:** 9.9 mi (16 km, 16000 m)"
    `);
  });
});
