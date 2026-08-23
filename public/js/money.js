// Client-side money parsing contract (docs/DATA-MODEL.md): amounts cross the
// API as integer minor units only; binary floats never participate in money
// math. Mirrors src/core/money.js semantics, except that client input with
// more than 2 fractional digits is rejected instead of rounded.

const MAX_SAFE_MINOR = 9007199254740991n;

const SYMBOLS = /[$€£¥₹₩₽]/g;
const MINUS_CHARS = /[\u2212\u2012\u2013\u2014\uFE63\uFF0D-]/g;
const SPACES = /[\s\u00A0\u202F\u2009]/g;

/**
 * Parse a user-typed amount string into integer minor units using BigInt
 * end-to-end. Accepts currency symbols, spaces/NBSP, parentheses negatives,
 * unicode minus, trailing CR/D markers, '+'/'-' signs, thousands grouping
 * when strict 3-digit groups ("1,234" / "1.234.567"), and decimal comma or
 * dot. Returns null for anything invalid, including >2 fractional digits.
 */
export function parseAmountToMinorExact(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === '') return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  s = s.replace(SPACES, '');

  if (/[Cc][Rr]$/.test(s)) {
    s = s.slice(0, -2);
  } else if (/[Dd]$/.test(s)) {
    negative = !negative;
    s = s.slice(0, -1);
  }

  s = s.replace(MINUS_CHARS, '-');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  else if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1); }
  if (s.startsWith('+')) s = s.slice(1);

  s = s.replace(SYMBOLS, '').replace(/[A-Za-z]/g, '').replace(SPACES, '');
  if (s === '' || !/\d/.test(s) || !/^[\d.,'\u2019]+$/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart;
  let fracPart = '';

  if (lastDot >= 0 && lastComma >= 0) {
    const decSep = lastDot > lastComma ? '.' : ',';
    const parts = s.split(decSep);
    if (parts.length !== 2) return null;
    [intPart, fracPart] = parts;
    const other = decSep === '.' ? ',' : '.';
    if (fracPart.includes(other)) return null;
    intPart = intPart.split(other).join('');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const isStrictGrouping =
      parts.length >= 2 && parts.slice(1).every((p) => p.length === 3 && /^\d+$/.test(p));
    if (isStrictGrouping) intPart = parts.join('');
    else if (parts.length === 2) [intPart, fracPart] = parts;
    else return null;
  } else {
    intPart = s.replace(/[.,'\u2019]/g, '');
  }

  if (!/^\d*$/.test(fracPart) || !/^\d+$/.test(intPart)) return null;
  if (intPart.length > 13) return null;
  if (fracPart.length > 2) return null; // client contract: reject, never round

  const total = BigInt(intPart) * 100n + BigInt(fracPart.padEnd(2, '0'));
  if (total > MAX_SAFE_MINOR) return null;
  return negative ? -Number(total) : Number(total);
}

/**
 * Integer minor units -> plain signed major-unit string for prefilling
 * inputs: -123456 -> "-1234.56". Returns '' for non-integer input.
 */
export function minorToDecimalString(minor) {
  if (!Number.isInteger(minor)) return '';
  const sign = minor < 0 ? '-' : '';
  const abs = BigInt(Math.abs(minor));
  const whole = (abs / 100n).toString();
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${cents}`;
}
