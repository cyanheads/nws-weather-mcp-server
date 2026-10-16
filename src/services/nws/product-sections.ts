/**
 * @fileoverview Pure partition of an NWS narrative text product into addressable parts.
 * An AFD splits at its `.NAME...` section header lines; ZFP, HWO, and SPS split into
 * `$$`-terminated UGC segments keyed by every zone their UGC line covers. Text before
 * the first part is the header, text after the last is the trailer. Every scan is a
 * single pass over the product's lines with no backtracking regex, so cost stays
 * linear in the product size.
 * @module services/nws/product-sections
 */

/** One `PPZNNN` or `PPZNNN>MMM` run of a UGC line. */
interface ZoneRun {
  readonly from: number;
  readonly prefix: string;
  readonly to: number;
}

/** One addressable part of a narrative product. */
export interface ProductPart {
  /** A UGC segment's first area-name line (`City of Seattle`); absent for AFD sections. */
  readonly label?: string;
  /**
   * AFD section name (`AVIATION`), or a UGC segment's zone codes as issued, ranges
   * kept in NWS form (`FLZ076>078, IDZ001`).
   */
  readonly name: string;
  /** The part's text verbatim, trailing blank lines dropped. */
  readonly text: string;
  /** Zone runs a UGC segment covers; empty for AFD sections. */
  readonly zones: readonly ZoneRun[];
}

/** A product split into header, parts in product order, and trailer. */
export interface ProductPartition {
  readonly header: string;
  readonly parts: readonly ProductPart[];
  readonly trailer: string;
}

const AFD_HEADER = /^\.[A-Z]/;
const UGC_START = /^[A-Z]{2}[CZ]\d{3}[->]/;
const UGC_CHARS = /^[A-Z0-9>-]+$/;
const ZONE_TOKEN = /^([A-Z]{2}[CZ])?(\d{3})(?:>(\d{3}))?$/;
const ZONE_CODE = /^([A-Z]{2}[CZ])(\d{3})$/;
const EXPIRY = /^\d{6}$/;
const ISSUED_QUALIFIER = /,\s*issued\b/i;

/**
 * Splits a narrative product into its parts. `productCode` picks the scheme: `AFD`
 * splits at section headers, every other type into UGC segments. A product with no
 * recognizable part comes back as header only.
 */
export function partitionProduct(productText: string, productCode: string): ProductPartition {
  const lines = productText.split('\n');
  return productCode === 'AFD' ? partitionAfd(lines) : partitionUgc(lines);
}

/**
 * Whether a caller-supplied `sections` entry selects this part: an AFD section name
 * (case- and spacing-insensitive), the part's `name` as listed, or any zone code the
 * segment's UGC line covers.
 */
export function partMatches(part: ProductPart, wanted: string): boolean {
  const key = normalizeKey(wanted);
  if (key === normalizeKey(part.name)) return true;
  const code = ZONE_CODE.exec(key);
  if (!code) return false;
  const [, prefix, digits] = code;
  const n = Number(digits);
  return part.zones.some((run) => run.prefix === prefix && run.from <= n && n <= run.to);
}

function collapseSpaces(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ');
}

function normalizeKey(value: string): string {
  return collapseSpaces(value).toUpperCase();
}

function partitionAfd(lines: readonly string[]): ProductPartition {
  const starts: number[] = [];
  let stop = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.startsWith('$$')) {
      stop = i;
      break;
    }
    if (AFD_HEADER.test(line)) starts.push(i);
  }
  const parts = starts.map((start, idx) => {
    const end = starts[idx + 1] ?? stop;
    return {
      name: afdSectionName(lines[start] as string, lines[start + 1]),
      text: joinTrimmed(lines, start, end),
      zones: [],
    };
  });
  return assemble(lines, starts[0], stop, parts);
}

/**
 * A section header's name: the text before the first `...` (joining a header that
 * wraps onto the next line), minus a trailing `, Issued …`, ` (…)`, or ` /…/` qualifier.
 */
function afdSectionName(line: string, next: string | undefined): string {
  let header = line.slice(1);
  if (!header.includes('...') && next?.includes('...')) header = `${header} ${next}`;
  const dots = header.indexOf('...');
  let name = dots >= 0 ? header.slice(0, dots) : header;

  const issued = ISSUED_QUALIFIER.exec(name);
  if (issued) name = name.slice(0, issued.index);

  name = name.trimEnd();
  const open = name.lastIndexOf('(');
  if (open > 0) {
    const close = name.indexOf(')', open);
    if (close === -1 || close === name.length - 1) name = name.slice(0, open).trimEnd();
  }

  if (name.endsWith('/')) {
    const slash = name.indexOf('/');
    if (slash > 0 && slash < name.length - 1) name = name.slice(0, slash);
  }

  return collapseSpaces(name);
}

function partitionUgc(lines: readonly string[]): ProductPartition {
  const blocks: { label?: string; name: string; start: number; zones: ZoneRun[] }[] = [];
  let last = -1;
  let i = 0;
  while (i < lines.length) {
    const first = (lines[i] as string).trimEnd();
    if (!UGC_START.test(first) || !UGC_CHARS.test(first)) {
      i++;
      continue;
    }
    // A UGC line wraps at a hyphen and ends with the 6-digit expiry token.
    const ugcLines = [first];
    let j = i;
    while (!endsWithExpiry(ugcLines[ugcLines.length - 1] as string) && j + 1 < lines.length) {
      const nextLine = (lines[j + 1] as string).trimEnd();
      if (!UGC_CHARS.test(nextLine)) break;
      ugcLines.push(nextLine);
      j++;
    }
    if (!endsWithExpiry(ugcLines[ugcLines.length - 1] as string)) {
      // Not a UGC line; none of the lines it absorbed can start one either.
      i = j + 1;
      continue;
    }
    let end = j + 1;
    while (end < lines.length && !(lines[end] as string).startsWith('$$')) end++;
    const { name, zones } = parseUgc(ugcLines.join(''));
    const label = lines[j + 1]?.trim().replace(/-$/, '');
    blocks.push({ name, start: i, zones, ...(label ? { label } : {}) });
    last = Math.min(end, lines.length - 1);
    i = last + 1;
  }

  const parts = blocks.map(({ start, ...block }, idx) => ({
    ...block,
    text: joinTrimmed(lines, start, blocks[idx + 1]?.start ?? last + 1),
  }));
  return assemble(lines, blocks[0]?.start, last + 1, parts);
}

/** Whether a UGC line ends with its `-DDHHMM-` expiry token (alone on a wrapped line, or after a hyphen). */
function endsWithExpiry(line: string): boolean {
  if (!line.endsWith('-') || line.length < 7) return false;
  if (line.length > 7 && line[line.length - 8] !== '-') return false;
  return EXPIRY.test(line.slice(-7, -1));
}

/** Zone runs and display name of a UGC line: a prefixed token sets the prefix for the bare ones after it. */
function parseUgc(ugc: string): { name: string; zones: ZoneRun[] } {
  const zones: ZoneRun[] = [];
  const tokens: string[] = [];
  let prefix = '';
  for (const token of ugc.split('-')) {
    const match = ZONE_TOKEN.exec(token);
    if (!match) continue;
    const [, tokenPrefix, from, to] = match;
    if (tokenPrefix) prefix = tokenPrefix;
    if (!prefix) continue;
    zones.push({ prefix, from: Number(from), to: Number(to ?? from) });
    tokens.push(to ? `${prefix}${from}>${to}` : `${prefix}${from}`);
  }
  return { name: tokens.length ? tokens.join(', ') : ugc, zones };
}

/** Lines `[start, end)` joined, trailing blank lines dropped. */
function joinTrimmed(lines: readonly string[], start: number, end: number): string {
  let stop = end;
  while (stop > start && (lines[stop - 1] as string).trim() === '') stop--;
  return lines.slice(start, stop).join('\n');
}

function assemble(
  lines: readonly string[],
  firstStart: number | undefined,
  trailerStart: number,
  parts: ProductPart[],
): ProductPartition {
  if (firstStart === undefined) return { header: lines.join('\n'), parts: [], trailer: '' };
  return {
    header: joinTrimmed(lines, 0, firstStart),
    parts,
    trailer: lines.slice(trailerStart).join('\n'),
  };
}
