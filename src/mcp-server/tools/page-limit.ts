/**
 * @fileoverview Serves a `limit` past a tool's per-page cap up to that cap and
 * discloses the clamp, for the tools that page a collection.
 * @module mcp-server/tools/page-limit
 */

/**
 * Hard ceiling on any `limit` input. It clears every collection these tools serve
 * (a metro grid cell's stations, the national active-alert set, a busy station's
 * 7-day history), so only bulk-script sizes fail at the schema.
 */
export const LIMIT_CEILING = 10_000;

/** A first page's size, with the disclosure owed when the caller asked for more. */
export interface PageLimit {
  /** Set only when the requested limit exceeded the cap. */
  readonly clamp?: {
    /** The `requestedLimit`/`effectiveLimit` enrichment pair. */
    readonly fields: { readonly effectiveLimit: number; readonly requestedLimit: number };
    /** The sentence that opens the page's notice. */
    readonly notice: string;
  };
  /** The page size to apply: the requested limit, held to the cap. */
  readonly effectiveLimit: number;
}

/** Hold a first page's requested `limit` to `cap`, naming the clamp when one applied. */
export function clampPageLimit(requestedLimit: number, cap: number): PageLimit {
  if (requestedLimit <= cap) return { effectiveLimit: requestedLimit };
  return {
    effectiveLimit: cap,
    clamp: {
      fields: { requestedLimit, effectiveLimit: cap },
      notice: `Requested limit ${requestedLimit} exceeds the per-page cap of ${cap}; this page holds up to ${cap}.`,
    },
  };
}

/** Join the notices a page owes into the one `notice` it carries, in order. */
export function composeNotice(...parts: readonly (string | undefined)[]): string | undefined {
  const text = parts.filter((part) => part).join(' ');
  return text || undefined;
}
