/**
 * @fileoverview Shared formatting utilities for tool format() functions.
 * @module mcp-server/tools/format-utils
 */

const ISO_WITH_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

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
