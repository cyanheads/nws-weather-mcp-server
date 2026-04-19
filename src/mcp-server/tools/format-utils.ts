/**
 * @fileoverview Shared formatting utilities for tool format() functions.
 * @module mcp-server/tools/format-utils
 */

const ISO_WITH_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Primary IANA time zone for each US state, territory, and DC. NWS zone codes
 * use a 2-letter state prefix (e.g., `WAZ558`, `OKC033`); the prefix is what
 * we look up here. States that span multiple zones (e.g., FL, ID, IN, KS, KY,
 * MI, ND, NE, OR, SD, TN, TX) resolve to their predominant zone — the
 * approximation is acceptable for display purposes since the alert's full
 * detail does not depend on the rendered abbreviation.
 */
const STATE_TZ_MAP: Readonly<Record<string, string>> = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  DC: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  ID: 'America/Boise',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/Detroit',
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago',
  NV: 'America/Los_Angeles',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
  AS: 'Pacific/Pago_Pago',
  GU: 'Pacific/Guam',
  MP: 'Pacific/Guam',
  PR: 'America/Puerto_Rico',
  VI: 'America/Puerto_Rico',
};

const ZONE_CODE_RE = /^([A-Z]{2})[ZC]\d{3}$/;

/**
 * Derive a representative IANA timezone from an NWS zone or county code.
 *
 * @param zoneCode - NWS zone (`WAZ558`) or county code (`WAC033`).
 * @returns The state's primary IANA zone, or `undefined` when the code is
 *   missing, malformed, or its state prefix isn't in the map.
 */
export function zoneCodeToTimeZone(zoneCode: string | undefined | null): string | undefined {
  if (!zoneCode) return;
  const match = ZONE_CODE_RE.exec(zoneCode.toUpperCase());
  const statePrefix = match?.[1];
  if (!statePrefix) return;
  return STATE_TZ_MAP[statePrefix];
}

/** Convert Celsius to Fahrenheit. */
export function cToF(c: number): number {
  return Math.round(c * 1.8 + 32);
}

/** Convert Fahrenheit to Celsius. */
export function fToC(f: number): number {
  return Math.round(((f - 32) * 5) / 9);
}

function formatTimestampWithOffset(iso: string): string {
  const match = ISO_WITH_OFFSET_RE.exec(iso);
  if (!match) return iso;

  const [, year, month, day, hour, minute, offset] = match;
  const wallClock = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)),
  );
  const formatted = wallClock.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  const zone = offset === 'Z' ? 'UTC' : `UTC${offset}`;
  return `${formatted} ${zone}`;
}

/** Format an ISO 8601 timestamp as a short human-readable string. */
export function formatTimestamp(iso: string, timeZone?: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  if (!timeZone) {
    return formatTimestampWithOffset(iso);
  }

  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  });
}
