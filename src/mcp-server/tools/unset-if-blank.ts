/**
 * @fileoverview Shared normalization for optional string inputs, so a blank value
 * is unset on every tool that accepts one.
 * @module mcp-server/tools/unset-if-blank
 */

/**
 * Trim an optional string input and treat a blank one as unset. Form-based clients
 * send every optional field they display, empty ones as "", so a blank or
 * whitespace-only value must read as omitted (issue #46).
 */
export function unsetIfBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
