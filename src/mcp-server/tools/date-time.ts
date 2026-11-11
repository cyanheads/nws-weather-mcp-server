/**
 * @fileoverview The ISO 8601 date-time grammar the time-window inputs share:
 * the advertised JSON Schema pattern and the calendar-checked parse the handlers
 * run before any NWS request.
 * @module mcp-server/tools/date-time
 */

/**
 * An ISO 8601 date-time with seconds and an explicit offset. NWS answers a date-only
 * value, one without seconds, or one with more than six fractional-second digits
 * with a 400, and a calendar-invalid one with a 500, so the handler validates
 * before any request goes out. NWS reads a lowercase `t` or `z` and an offset
 * without its colon (`+0000`) as the same instant, so those parse too.
 */
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:[Zz]|([+-])(\d{2}):?(\d{2}))$/;

/**
 * The shape advertised as a JSON Schema `pattern` (issue #54), applied by a
 * validating client to the raw value: DATE_TIME_RE's grammar without its captures,
 * admitting surrounding whitespace, which the handler trims, and a blank, which is
 * unset. Calendar validity, offset range, and window order stay in the handler as
 * `invalid_time_window`. No `format: "date-time"`: a padded or blank value fails
 * it, and it admits forms NWS refuses. A trailing `\s*` never follows another `\s*`
 * across an empty match, so a backtracking engine stays linear on a long
 * whitespace run.
 */
export const DATE_TIME_INPUT_PATTERN =
  /^\s*(?:\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[Zz]|[+-]\d{2}:?\d{2})\s*)?$/;

/** A date-time that parsed: its instant and the spelling sent upstream. */
export interface DateTime {
  readonly epochMs: number;
  /**
   * The value in canonical form — uppercase `T` and `Z`, a `±HH:MM` offset — with
   * its digits as given. The handlers send this form to NWS and mint it into
   * cursors, whichever accepted form the caller used.
   */
  readonly text: string;
}

/**
 * Parse a well-formed, calendar-valid date-time, or return undefined. `Date` rolls
 * an out-of-range component into the next unit (Feb 30 reads as Mar 2), so every
 * component is checked by round-tripping it through `Date.UTC` instead of
 * trusting a parse.
 */
export function parseDateTime(value: string): DateTime | undefined {
  const match = DATE_TIME_RE.exec(value);
  if (!match) return;
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi ||
    check.getUTCSeconds() !== s
  ) {
    return;
  }

  const [, year, month, day, hour, minute, second, fraction, sign, offsetHour, offsetMinute] =
    match;
  let offsetMs = 0;
  if (sign) {
    const oh = Number(offsetHour);
    const om = Number(offsetMinute);
    if (oh > 23 || om > 59) return;
    offsetMs = (sign === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  const fractionMs = fraction ? Number(`0.${fraction}`) * 1000 : 0;
  const offset = sign ? `${sign}${offsetHour}:${offsetMinute}` : 'Z';
  return {
    epochMs: wall + fractionMs - offsetMs,
    text: `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ? `.${fraction}` : ''}${offset}`,
  };
}
