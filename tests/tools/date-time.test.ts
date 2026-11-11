/**
 * @fileoverview Tests for the shared ISO 8601 date-time grammar: the calendar-checked
 * parse, its canonical spelling, the advertised input pattern, and the pattern's
 * linear cost on adversarial input.
 * @module tests/tools/date-time
 */

import { describe, expect, it } from 'vitest';
import { DATE_TIME_INPUT_PATTERN, parseDateTime } from '@/mcp-server/tools/date-time.js';

/** 2026-10-15T12:00:00Z, the instant most cases below name. */
const NOON_UTC = Date.UTC(2026, 9, 15, 12, 0, 0);

describe('parseDateTime', () => {
  it.each([
    ['2026-10-15T12:00:00Z', NOON_UTC],
    ['2026-10-15T05:00:00-07:00', NOON_UTC],
    ['2026-10-15T17:30:00+05:30', NOON_UTC],
    ['2026-10-15T12:00:00+00:00', NOON_UTC],
    ['2026-10-15T12:00:00-00:00', NOON_UTC],
    ['2026-10-15T12:00:00.5Z', NOON_UTC + 500],
    ['2026-10-15T12:00:00.123456Z', NOON_UTC + 123.456],
    ['2024-02-29T00:00:00Z', Date.UTC(2024, 1, 29)],
  ])('reads the canonical %s as its instant and keeps its spelling', (value, epochMs) => {
    expect(parseDateTime(value)).toEqual({ epochMs, text: value });
  });

  it.each([
    ['2026-10-15t12:00:00z', '2026-10-15T12:00:00Z', NOON_UTC],
    ['2026-10-15t12:00:00Z', '2026-10-15T12:00:00Z', NOON_UTC],
    ['2026-10-15T12:00:00z', '2026-10-15T12:00:00Z', NOON_UTC],
    ['2026-10-15T12:00:00+0000', '2026-10-15T12:00:00+00:00', NOON_UTC],
    ['2026-10-15T05:00:00-0700', '2026-10-15T05:00:00-07:00', NOON_UTC],
    ['2026-10-15t17:30:00+0530', '2026-10-15T17:30:00+05:30', NOON_UTC],
    ['2026-10-15T05:00:00.25-0700', '2026-10-15T05:00:00.25-07:00', NOON_UTC + 250],
  ])('reads %s, a form NWS accepts, as %s', (value, text, epochMs) => {
    expect(parseDateTime(value)).toEqual({ epochMs, text });
  });

  it.each([
    ['a date only', '2026-10-15'],
    ['no seconds', '2026-10-15T12:00Z'],
    ['no offset', '2026-10-15T12:00:00'],
    ['seven fractional digits', '2026-10-15T12:00:00.1234567Z'],
    ['an empty fraction', '2026-10-15T12:00:00.Z'],
    ['a space for T', '2026-10-15 12:00:00Z'],
    ['an hour-only offset', '2026-10-15T12:00:00+05'],
    ['a three-digit offset', '2026-10-15T12:00:00+053'],
    ['a misplaced offset colon', '2026-10-15T12:00:00+053:0'],
    ['an offset past 23 hours', '2026-10-15T12:00:00+24:00'],
    ['an offset minute past 59', '2026-10-15T12:00:00+05:60'],
    ['a lowercase offset Z after an offset', '2026-10-15T12:00:00+00:00z'],
    ['February 30', '2026-02-30T00:00:00Z'],
    ['February 29 outside a leap year', '2026-02-29T00:00:00Z'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['hour 24', '2026-10-15T24:00:00Z'],
    ['minute 60', '2026-10-15T12:60:00Z'],
    ['second 60', '2026-10-15T12:00:60Z'],
    ['surrounding whitespace, which the handlers trim first', ' 2026-10-15T12:00:00Z '],
    ['a blank', ''],
  ])('refuses %s', (_label, value) => {
    expect(parseDateTime(value)).toBeUndefined();
  });
});

describe('DATE_TIME_INPUT_PATTERN', () => {
  const admitted = [
    '2026-10-15T12:00:00Z',
    '2026-10-15T05:00:00-07:00',
    '2026-10-15T12:00:00.123456Z',
    '2026-10-15t12:00:00z',
    '2026-10-15T12:00:00+0000',
    '2026-10-15t05:00:00.5-0700',
    ' 2026-10-15T12:00:00Z ',
    '\t2026-10-15t12:00:00+0000\n',
    '',
    '   ',
  ];
  const refused = [
    '2026-10-15',
    '2026-10-15T12:00Z',
    '2026-10-15T12:00:00',
    '2026-10-15T12:00:00.1234567Z',
    '2026-10-15 12:00:00Z',
    '2026-10-15T12:00:00+05',
    '2026-10-15T12:00:00+053:0',
    'x2026-10-15T12:00:00Z',
  ];

  it.each(admitted)('admits %j', (value) => {
    expect(DATE_TIME_INPUT_PATTERN.test(value)).toBe(true);
  });

  it.each(refused)('refuses %j', (value) => {
    expect(DATE_TIME_INPUT_PATTERN.test(value)).toBe(false);
  });

  it('admits every value parseDateTime accepts, so a validating client never refuses one the server serves', () => {
    const served = [...admitted, ...refused].filter(
      (value) => parseDateTime(value.trim()) !== undefined,
    );

    expect(served.length).toBeGreaterThan(5);
    for (const value of served) expect(DATE_TIME_INPUT_PATTERN.test(value), value).toBe(true);
  });
});

/**
 * Clients compile the advertised pattern over caller text, most with a backtracking
 * engine, and the handlers run the parse over trimmed caller text. Each shape is
 * timed in thread CPU, least of several runs: the short text per call over a batch,
 * the long text one call at a time. The long side doubles from twice the short
 * length, failing at the first length past the absolute bound, and at the full 64×
 * span the per-call ratio to the short side — re-timed beside the long side — must
 * stay under 256 (linear growth is 64, quadratic 4096) on the least of three pairs.
 * The digit run carries 5k → 320k; the other shapes stop at 40k, below the length
 * where Bun's engine (JavaScriptCore) moves a long scan onto a slower path, a
 * constant-factor step that is not growth.
 */
describe('date-time grammar cost on adversarial input', () => {
  const cpuMs = () => {
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
  };
  /** Least thread CPU, per call, of three runs of `calls` calls on `text`. */
  const perCall = (run: (text: string) => unknown, text: string, calls: number) => {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = cpuMs();
      for (let i = 0; i < calls; i++) run(text);
      best = Math.min(best, (cpuMs() - start) / calls);
    }
    return best;
  };

  const shapes = [
    { name: 'digit run', short: 5_000, build: (n: number) => `${'1'.repeat(n)}!` },
    { name: 'whitespace run', short: 625, build: (n: number) => `${' '.repeat(n)}!` },
    {
      name: 'value then whitespace run',
      short: 625,
      build: (n: number) => `2026-10-15T12:00:00Z${' '.repeat(n)}!`,
    },
    {
      name: 'one long line ending in a break',
      short: 625,
      build: (n: number) => `${'§1 x'.repeat(n / 4)}\ny`,
    },
    { name: 'breaks throughout', short: 625, build: (n: number) => '  \r\n'.repeat(n / 4) },
    {
      name: 'repeated date prefix',
      short: 625,
      build: (n: number) => '2026-10-15T'.repeat(Math.ceil(n / 11)),
    },
  ];
  const subjects = [
    ['DATE_TIME_INPUT_PATTERN', (text: string) => DATE_TIME_INPUT_PATTERN.test(text)],
    ['parseDateTime', (text: string) => parseDateTime(text)],
  ] as const;

  it('stays linear on every shape', () => {
    const slow: string[] = [];
    for (const [subject, run] of subjects) {
      for (const shape of shapes) {
        const span = shape.short * 64;
        const shortText = shape.build(shape.short);
        let verdict = '';
        for (let length = shape.short * 2; length <= span; length *= 2) {
          const longText = shape.build(length);
          const longCall = perCall(run, longText, 1);
          if (longCall >= 50) {
            verdict = `${subject} on ${shape.name}: ${longCall.toFixed(2)} ms at ${length}`;
            break;
          }
          if (length < span) continue;
          let ratio = Number.POSITIVE_INFINITY;
          for (let pair = 0; pair < 3; pair++) {
            // A 1µs floor under the short side keeps timer noise on near-instant
            // refusals from reading as growth.
            const shortCall = Math.max(perCall(run, shortText, 64), 0.001);
            ratio = Math.min(ratio, perCall(run, longText, 1) / shortCall);
          }
          if (ratio >= 256) {
            verdict = `${subject} on ${shape.name}: ratio ${ratio.toFixed(0)} at ${span}`;
          }
        }
        if (verdict) slow.push(verdict);
      }
    }

    expect(slow).toEqual([]);
  });
});
