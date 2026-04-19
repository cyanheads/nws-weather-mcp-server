/**
 * @fileoverview Tests for shared formatting utilities.
 * @module tests/tools/format-utils
 */

import { describe, expect, it } from 'vitest';
import {
  cToF,
  formatTimestamp,
  fToC,
  zoneCodeToTimeZone,
} from '@/mcp-server/tools/format-utils.js';

describe('cToF / fToC', () => {
  it('converts Celsius to Fahrenheit', () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(cToF(-40)).toBe(-40);
  });

  it('converts Fahrenheit to Celsius', () => {
    expect(fToC(32)).toBe(0);
    expect(fToC(212)).toBe(100);
    expect(fToC(-40)).toBe(-40);
  });
});

describe('formatTimestamp', () => {
  describe('with explicit IANA time zone', () => {
    it('renders a UTC instant in the requested zone with named abbreviation (DST)', () => {
      // 15:00 UTC on 2026-04-19 = 8:00 AM PDT (during DST)
      const out = formatTimestamp('2026-04-19T15:00:00Z', 'America/Los_Angeles');
      expect(out).toContain('8:00 AM');
      expect(out).toContain('PDT');
      expect(out).toContain('Apr 19');
    });

    it('renders standard time abbreviation outside DST', () => {
      // 20:00 UTC on 2026-01-15 = 12:00 PM PST (standard time)
      const out = formatTimestamp('2026-01-15T20:00:00Z', 'America/Los_Angeles');
      expect(out).toContain('12:00 PM');
      expect(out).toContain('PST');
      expect(out).toContain('Jan 15');
    });

    it('renders Eastern, Central, Mountain, Hawaii zones with the right abbreviations', () => {
      const summer = '2026-07-04T16:00:00Z'; // 16:00 UTC
      expect(formatTimestamp(summer, 'America/New_York')).toContain('EDT');
      expect(formatTimestamp(summer, 'America/Chicago')).toContain('CDT');
      expect(formatTimestamp(summer, 'America/Denver')).toContain('MDT');
      expect(formatTimestamp(summer, 'America/Phoenix')).toContain('MST'); // No DST
      expect(formatTimestamp(summer, 'Pacific/Honolulu')).toContain('HST'); // No DST
    });

    it('respects the offset baked into the ISO string when converting to the zone', () => {
      // 06:00 PDT (which is 13:00 UTC) — same instant rendered in the same zone should be 6:00 AM
      const out = formatTimestamp('2026-04-19T06:00:00-07:00', 'America/Los_Angeles');
      expect(out).toContain('6:00 AM');
      expect(out).toContain('PDT');
    });
  });

  describe('without time zone', () => {
    it('renders ISO with offset using the offset suffix', () => {
      const out = formatTimestamp('2026-04-19T15:00:00-04:00');
      expect(out).toContain('Apr 19');
      expect(out).toContain('3:00 PM');
      expect(out).toContain('UTC-04:00');
    });

    it('renders ISO with Z using UTC suffix', () => {
      const out = formatTimestamp('2026-04-19T15:00:00Z');
      expect(out).toContain('Apr 19');
      expect(out).toContain('3:00 PM');
      expect(out).toContain('UTC');
      // Should not produce a numeric offset since it's already UTC
      expect(out).not.toMatch(/UTC[+-]\d/);
    });

    it('renders ISO with positive offset', () => {
      const out = formatTimestamp('2026-04-19T15:00:00+02:00');
      expect(out).toContain('UTC+02:00');
    });

    it('treats explicit undefined and null timeZone the same as omission', () => {
      const iso = '2026-04-19T15:00:00-07:00';
      const baseline = formatTimestamp(iso);
      expect(formatTimestamp(iso, undefined)).toBe(baseline);
      expect(formatTimestamp(iso, null)).toBe(baseline);
    });
  });

  describe('error handling', () => {
    it('returns the original string for an unparseable timestamp', () => {
      expect(formatTimestamp('not-a-date')).toBe('not-a-date');
      expect(formatTimestamp('not-a-date', 'America/Los_Angeles')).toBe('not-a-date');
    });

    it('returns the original string for ISO formats the offset regex does not match', () => {
      // Date.parse handles this, but the offset-only formatter falls back to it
      const weird = '2026-04-19T15:00:00';
      expect(formatTimestamp(weird)).toBe(weird);
    });
  });
});

describe('zoneCodeToTimeZone', () => {
  it('maps zone codes (Z) to the state primary IANA zone', () => {
    expect(zoneCodeToTimeZone('WAZ558')).toBe('America/Los_Angeles');
    expect(zoneCodeToTimeZone('NYZ072')).toBe('America/New_York');
    expect(zoneCodeToTimeZone('OKZ033')).toBe('America/Chicago');
    expect(zoneCodeToTimeZone('COZ001')).toBe('America/Denver');
  });

  it('maps county codes (C) to the state primary IANA zone', () => {
    expect(zoneCodeToTimeZone('WAC033')).toBe('America/Los_Angeles');
    expect(zoneCodeToTimeZone('CAC037')).toBe('America/Los_Angeles');
    expect(zoneCodeToTimeZone('TXC201')).toBe('America/Chicago');
  });

  it('handles US territories', () => {
    expect(zoneCodeToTimeZone('PRZ001')).toBe('America/Puerto_Rico');
    expect(zoneCodeToTimeZone('VIZ001')).toBe('America/Puerto_Rico');
    expect(zoneCodeToTimeZone('HIZ001')).toBe('Pacific/Honolulu');
    expect(zoneCodeToTimeZone('AKZ021')).toBe('America/Anchorage');
    expect(zoneCodeToTimeZone('GUZ001')).toBe('Pacific/Guam');
  });

  it('is case insensitive', () => {
    expect(zoneCodeToTimeZone('waz558')).toBe('America/Los_Angeles');
    expect(zoneCodeToTimeZone('WaC033')).toBe('America/Los_Angeles');
  });

  it('returns undefined for null, undefined, or empty input', () => {
    expect(zoneCodeToTimeZone(undefined)).toBeUndefined();
    expect(zoneCodeToTimeZone(null)).toBeUndefined();
    expect(zoneCodeToTimeZone('')).toBeUndefined();
  });

  it('returns undefined for malformed codes', () => {
    expect(zoneCodeToTimeZone('XYZ')).toBeUndefined(); // too short / wrong middle
    expect(zoneCodeToTimeZone('WA558')).toBeUndefined(); // missing Z/C
    expect(zoneCodeToTimeZone('WAX558')).toBeUndefined(); // wrong middle char
    expect(zoneCodeToTimeZone('WAZ55')).toBeUndefined(); // too few digits
    expect(zoneCodeToTimeZone('WAZ5588')).toBeUndefined(); // too many digits
    expect(zoneCodeToTimeZone('1AZ558')).toBeUndefined(); // numeric prefix
  });

  it('returns undefined for an unknown US state prefix', () => {
    // ZZ is not a real US state prefix
    expect(zoneCodeToTimeZone('ZZZ001')).toBeUndefined();
  });

  it('produces zones that all resolve through Intl (no typos)', () => {
    // Round-trip every entry through Intl.DateTimeFormat to catch typos in the static map.
    const samplePrefixes = [
      'AL',
      'AK',
      'AZ',
      'AR',
      'CA',
      'CO',
      'CT',
      'DE',
      'DC',
      'FL',
      'GA',
      'HI',
      'ID',
      'IL',
      'IN',
      'IA',
      'KS',
      'KY',
      'LA',
      'ME',
      'MD',
      'MA',
      'MI',
      'MN',
      'MS',
      'MO',
      'MT',
      'NE',
      'NV',
      'NH',
      'NJ',
      'NM',
      'NY',
      'NC',
      'ND',
      'OH',
      'OK',
      'OR',
      'PA',
      'RI',
      'SC',
      'SD',
      'TN',
      'TX',
      'UT',
      'VT',
      'VA',
      'WA',
      'WV',
      'WI',
      'WY',
      'AS',
      'GU',
      'MP',
      'PR',
      'VI',
    ];
    for (const prefix of samplePrefixes) {
      const tz = zoneCodeToTimeZone(`${prefix}Z001`);
      expect(tz, `state ${prefix} should resolve`).toBeDefined();
      // If Intl rejects the zone, this throws — proves the IANA name is valid
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow();
    }
  });
});
