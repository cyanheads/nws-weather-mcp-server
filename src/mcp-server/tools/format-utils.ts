/**
 * @fileoverview Shared formatting utilities for tool format() functions.
 * @module mcp-server/tools/format-utils
 */

/** Convert Celsius to Fahrenheit. */
export function cToF(c: number): number {
  return Math.round(c * 1.8 + 32);
}

/** Format an ISO 8601 timestamp as a short human-readable string. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}
