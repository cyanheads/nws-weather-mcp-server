/**
 * @fileoverview Tests for the narrative-product partition parser: AFD section headers
 * (wrapped and qualified), UGC segments (ranges, multi-prefix and wrapped lines), lossless
 * partition over real NWS products, and linear scaling on adversarial shapes.
 * @module tests/services/nws/product-sections
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type ProductPart,
  partitionProduct,
  partMatches,
} from '@/services/nws/product-sections.js';

interface ProductFixture {
  productCode: string;
  productText: string;
}

const loadProduct = (name: string): ProductFixture =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/products/${name}.json`, import.meta.url), 'utf8'),
  ) as ProductFixture;

const partitionFixture = (name: string) => {
  const product = loadProduct(name);
  return partitionProduct(product.productText, product.productCode);
};

const namesOf = (parts: readonly ProductPart[]) => parts.map((part) => part.name);
const nonBlankLines = (text: string) => text.split('\n').filter((line) => line.trim() !== '');

describe('partitionProduct — AFD sections', () => {
  it('names each section from the text before its first "..."', () => {
    const { parts } = partitionFixture('box-afd');
    expect(namesOf(parts)).toEqual([
      'WHAT HAS CHANGED',
      'KEY MESSAGES',
      'DISCUSSION',
      'AVIATION',
      'MARINE',
      'BOX WATCHES/WARNINGS/ADVISORIES',
    ]);
  });

  it('strips a trailing /…/ qualifier from the section name', () => {
    const { parts } = partitionFixture('box-afd');
    const aviation = parts.find((part) => part.name === 'AVIATION');
    expect(aviation?.text.split('\n')[0]).toBe('.AVIATION /12Z FRIDAY THROUGH TUESDAY/...');
  });

  it('strips trailing ", Issued …" and (…) qualifiers', () => {
    expect(namesOf(partitionFixture('slc-afd').parts)).toEqual([
      'KEY MESSAGES',
      'DISCUSSION',
      'AVIATION',
      'FIRE WEATHER',
      'SLC WATCHES/WARNINGS/ADVISORIES',
    ]);
    expect(namesOf(partitionFixture('lox-afd').parts)).toEqual([
      'SYNOPSIS',
      'SHORT TERM',
      'LONG TERM',
      'AVIATION',
      'MARINE',
      'LOX WATCHES/WARNINGS/ADVISORIES',
    ]);
  });

  it('joins a header that wraps onto the next line', () => {
    const { parts } = partitionFixture('afc-afd');
    expect(namesOf(parts)).toEqual([
      'SHORT TERM FORECAST SOUTHCENTRAL ALASKA',
      'SHORT TERM FORECAST SOUTHWEST ALASKA/BERING SEA/ALEUTIANS',
      'LONG TERM FORECAST',
      'AVIATION',
    ]);
    // The wrapped header's second line stays inside its own section.
    expect(parts[1]?.text.split('\n').slice(0, 2)).toEqual([
      '.SHORT TERM FORECAST SOUTHWEST ALASKA/BERING SEA/ALEUTIANS (Days ',
      '1 through 3)...',
    ]);
  });

  it('ends a section at the next header even with no && between them', () => {
    const { parts } = partitionFixture('lox-afd');
    const shortTerm = parts.find((part) => part.name === 'SHORT TERM');
    expect(shortTerm?.text.startsWith('.SHORT TERM (TDY-SUN)...')).toBe(true);
    expect(shortTerm?.text).not.toContain('.LONG TERM');
  });

  it('keeps the product preamble as header and everything from $$ as trailer', () => {
    const { header, parts, trailer } = partitionFixture('box-afd');
    expect(header).toBe(
      '\n000\nFXUS61 KBOX 161159\nAFDBOX\n\nArea Forecast Discussion\nNational Weather Service Boston/Norton MA\n759 AM EDT Fri Oct 16 2026',
    );
    expect(trailer).toBe('$$\n\nDISCUSSION...Hrencecin\nAVIATION...Frank\nMARINE...Hrencecin\n');
    expect(parts.at(-1)?.text).not.toContain('$$');
  });

  it('returns a text with no section header as header only', () => {
    const text = 'FXUS66 KSEW 160935\nAFDSEW\n\nNo sections here.\n$$';
    expect(partitionProduct(text, 'AFD')).toEqual({ header: text, parts: [], trailer: '' });
  });
});

describe('partitionProduct — UGC segments', () => {
  it('splits a ZFP into $$-terminated segments with zone names and area labels', () => {
    const { header, parts } = partitionFixture('sew-zfp');
    expect(parts).toHaveLength(34);
    const seattle = parts.find((part) => part.name === 'WAZ315');
    expect(seattle?.label).toBe('City of Seattle');
    expect(seattle?.text.split('\n')[0]).toBe('WAZ315-162300-');
    expect(seattle?.text.trimEnd().endsWith('$$')).toBe(true);
    expect(seattle?.text.match(/^\$\$/gm)).toHaveLength(1);
    expect(header).toBe(
      '\n000\nFPUS56 KSEW 160937\nZFPSEW\n\nZone Forecast Product for Western Washington\nNational Weather Service Seattle WA\n236 AM PDT Fri Oct 16 2026\n\nSpot temperatures and probabilities of measurable precipitation\nare for today, tonight, and Saturday.',
    );
  });

  it('keys a UGC range on every zone it covers', () => {
    const { parts } = partitionFixture('key-zfp');
    expect(namesOf(parts)).toEqual(['FLZ076>078']);
    const [segment] = parts as [ProductPart];
    expect(['FLZ076', 'FLZ077', 'flz078'].map((code) => partMatches(segment, code))).toEqual([
      true,
      true,
      true,
    ]);
    expect(partMatches(segment, 'FLZ075')).toBe(false);
    expect(partMatches(segment, 'FLZ079')).toBe(false);
    expect(partMatches(segment, 'FLC077')).toBe(false);
  });

  it('carries each prefix across a multi-prefix UGC line', () => {
    const { parts } = partitionFixture('otx-zfp');
    const first = parts[0] as ProductPart;
    expect(first.name).toBe('IDZ001, WAZ037');
    expect(partMatches(first, 'WAZ037')).toBe(true);
    expect(partMatches(first, 'IDZ001')).toBe(true);
    expect(partMatches(first, 'IDZ037')).toBe(false);
    // The name as listed selects the segment too.
    expect(partMatches(first, 'IDZ001, WAZ037')).toBe(true);
    expect(parts.filter((part) => partMatches(part, 'WAZ037'))).toHaveLength(1);
  });

  it('reads a UGC line that wraps onto a second line', () => {
    const { parts } = partitionFixture('lot-hwo');
    expect(parts).toHaveLength(2);
    const land = parts[0] as ProductPart;
    expect(land.name).toBe(
      'ILZ003>006, ILZ008, ILZ010>013, ILZ019>021, ILZ023, ILZ032, ILZ033, ILZ039, ILZ103>108, INZ001, INZ002, INZ010, INZ011, INZ019',
    );
    // INZ019 sits on the wrapped second line of the UGC line.
    expect(partMatches(land, 'INZ019')).toBe(true);
    expect(partMatches(land, 'ILZ104')).toBe(true);
    expect(land.label).toBe('Winnebago-Boone-McHenry-Lake IL-Ogle-Lee-De Kalb-Kane-DuPage');
    expect(land.text).toContain('.DAY ONE...');
  });

  it('does not treat a UGC-shaped run with no expiry token as a segment', () => {
    const text = 'HEADER\n\nWAZ315-\nWAZ316-\nnot a ugc line\n$$\n';
    expect(partitionProduct(text, 'ZFP').parts).toEqual([]);
  });

  it('runs a final segment with no $$ to the end of the product', () => {
    const text = 'HEADER\n\nWAZ315-162300-\nCity of Seattle-\nBody text.';
    const { parts, trailer } = partitionProduct(text, 'ZFP');
    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).toBe('WAZ315-162300-\nCity of Seattle-\nBody text.');
    expect(trailer).toBe('');
  });
});

describe('partMatches — AFD names', () => {
  it('matches section names case- and spacing-insensitively', () => {
    const { parts } = partitionFixture('box-afd');
    const keyMessages = parts.find((part) => part.name === 'KEY MESSAGES') as ProductPart;
    expect(partMatches(keyMessages, 'key messages')).toBe(true);
    expect(partMatches(keyMessages, '  Key   Messages ')).toBe(true);
    expect(partMatches(keyMessages, 'KEY')).toBe(false);
  });
});

describe('partitionProduct — lossless over real products', () => {
  it.each([
    'afc-afd',
    'akq-zfp',
    'box-afd',
    'key-zfp',
    'lot-hwo',
    'lox-afd',
    'otx-zfp',
    'sew-zfp',
    'slc-afd',
  ])('%s: header, parts, and trailer hold every non-blank line in order', (name) => {
    const product = loadProduct(name);
    const { header, parts, trailer } = partitionProduct(product.productText, product.productCode);
    expect(parts.length).toBeGreaterThan(0);
    expect([
      ...nonBlankLines(header),
      ...parts.flatMap((part) => nonBlankLines(part.text)),
      ...nonBlankLines(trailer),
    ]).toEqual(nonBlankLines(product.productText));
  });
});

describe('partitionProduct — scaling', () => {
  /** Minimum thread CPU time (µs) of `fn` over a few runs. */
  const cpuMicros = (fn: () => void): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      fn();
      const used = process.threadCpuUsage(start);
      best = Math.min(best, used.user + used.system);
    }
    return best;
  };

  /** Each shape is sized to `chars` characters; the span runs 5k → 320k (64×). */
  const shapes: Record<string, (chars: number) => [string, string]> = {
    // One long UGC-shaped line: a zone token then a digit run with no expiry.
    'long digit run on a UGC line': (chars) => [`H\nWAZ001-${'1'.repeat(chars)}\n$$`, 'ZFP'],
    // Many UGC-shaped lines with no expiry token: each could start a segment.
    'UGC lines with no expiry': (chars) => ['WAZ001-\n'.repeat(Math.ceil(chars / 8)), 'ZFP'],
    // Many segments, each a UGC line, a label, and a $$ terminator.
    'many short segments': (chars) => [
      'WAZ001-162300-\nA-\n$$\n'.repeat(Math.ceil(chars / 21)),
      'ZFP',
    ],
    // Many AFD headers with no "..." whose next line has none either.
    'AFD headers with no dots': (chars) => ['.A\n'.repeat(Math.ceil(chars / 3)), 'AFD'],
    // One AFD header full of qualifier openers with no closer.
    'AFD header of repeated openers': (chars) => [
      `.A ${'(/, '.repeat(Math.ceil(chars / 4))}...`,
      'AFD',
    ],
  };

  it.each(Object.entries(shapes))('%s grows linearly from 5k to 320k characters', (_, build) => {
    const small = build(5_000);
    const time = ([text, code]: [string, string]) => cpuMicros(() => partitionProduct(text, code));
    // Warm the JIT before timing.
    time(small);
    const smallMicros = Math.max(time(small), 50);
    // Double up to 320k, failing at the first size past the absolute bound, so a
    // super-linear regression fails in seconds instead of running out the full span.
    let largeMicros = 0;
    for (let chars = 10_000; chars <= 320_000; chars *= 2) {
      largeMicros = time(build(chars));
      expect(largeMicros, `${chars} characters`).toBeLessThan(500_000);
    }
    expect(largeMicros / smallMicros).toBeLessThan(256);
  });
});
