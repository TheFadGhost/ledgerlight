// Money handling contract: ALL monetary values are integers in minor units
// (cents). Binary floats are banned for money everywhere, including
// intermediate calculations and chart aggregation. Parsing uses exact string
// arithmetic only.

const MAX_SAFE_MINOR = 9007199254740991;

export class MoneyFormatError extends Error {
  constructor(raw) {
    super(`Cannot parse amount: ${JSON.stringify(raw)}`);
    this.name = 'MoneyFormatError';
    this.raw = raw;
  }
}

const SYMBOLS = /[$€£¥₹₩₽]/g;
const MINUS_CHARS = /[\u2212\u2012\u2013\u2014\uFE63\uFF0D-]/g;
const SPACES = /[\s\u00A0\u202F\u2009]/g;

/**
 * Parse an amount string into integer minor units.
 * Handles currency symbols, spaces/NBSP, thousands grouping ('.' ',' space
 * apostrophe), decimal comma or point, parentheses negatives, unicode minus,
 * CR/D suffixes.
 *
 * decimalHint: 'dot' | 'comma' | null. When both separators appear the
 * rightmost wins regardless of hint. With a single separator and no hint,
 * strict 3-digit grouping ("1,234", "1.234.567") parses as grouped integers;
 * anything else splits at the separator as decimals.
 * >2 fractional digits round half away from zero (exact BigInt math).
 */
export function parseAmountToMinor(raw, decimalHint = null) {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) throw new MoneyFormatError(raw);
    return raw;
  }
  if (raw == null) throw new MoneyFormatError(raw);

  let s = String(raw).trim();
  let negative = false;

  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  s = s.replace(SPACES, '');

  if (/[Cc][Rr]$/.test(s)) {
    s = s.slice(0, -2); // credit: no sign change
  } else if (/[Dd]$/.test(s)) {
    negative = !negative; // debit marker
    s = s.slice(0, -1);
  }

  s = s.replace(MINUS_CHARS, '-');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  else if (s.endsWith('-')) { negative = !negative; s = s.slice(0, -1); }
  if (s.startsWith('+')) s = s.slice(1);

  s = s.replace(SYMBOLS, '').replace(/[A-Za-z]/g, '').replace(SPACES, '');
  if (s === '' || !/\d/.test(s) || !/^[\d.,'\u2019]+$/.test(s)) {
    throw new MoneyFormatError(raw);
  }

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart;
  let fracPart = '';

  if (lastDot >= 0 && lastComma >= 0) {
    const decSep = lastDot > lastComma ? '.' : ',';
    const parts = s.split(decSep);
    if (parts.length !== 2) throw new MoneyFormatError(raw);
    [intPart, fracPart] = parts;
    const other = decSep === '.' ? ',' : '.';
    if (fracPart.includes(other)) throw new MoneyFormatError(raw);
    intPart = intPart.split(other).join('');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const isStrictGrouping =
      parts.length >= 2 && parts.slice(1).every((p) => p.length === 3 && /^\d+$/.test(p));
    const hintedDecimal =
      (sep === '.' && decimalHint === 'dot') || (sep === ',' && decimalHint === 'comma');
    if (isStrictGrouping && !hintedDecimal) {
      intPart = parts.join('');
    } else if (parts.length === 2) {
      [intPart, fracPart] = parts;
    } else {
      throw new MoneyFormatError(raw);
    }
  } else {
    intPart = s.replace(/[.,'\u2019]/g, '');
  }

  if (!/^\d*$/.test(fracPart) || !/^\d+$/.test(intPart)) {
    throw new MoneyFormatError(raw);
  }
  if (intPart.length > 13) throw new MoneyFormatError(raw);

  let cents;
  if (fracPart.length <= 2) {
    cents = BigInt(fracPart.padEnd(2, '0'));
  } else {
    let kept = BigInt(fracPart.slice(0, 2));
    if (fracPart.charCodeAt(2) - 48 >= 5) kept += 1n;
    cents = kept;
  }

  const total = Number(BigInt(intPart) * 100n + cents);
  if (!Number.isSafeInteger(total) || total > MAX_SAFE_MINOR) {
    throw new MoneyFormatError(raw);
  }
  return negative ? -total : total;
}

/** Sum minor-unit integers with overflow guard. */
export function sumMinor(values) {
  let acc = 0;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new TypeError(`sumMinor: non-integer ${v}`);
    acc += v;
    if (!Number.isSafeInteger(acc)) throw new RangeError('sumMinor overflow');
  }
  return acc;
}

/** Integer-only basis points of part/whole. Returns percent*100, sign-correct. */
export function ratioBasisPoints(part, whole) {
  if (!Number.isInteger(part) || !Number.isInteger(whole)) {
    throw new TypeError('ratioBasisPoints requires integers');
  }
  if (whole === 0) return part === 0 ? 0 : null;
  const n = Number((BigInt(Math.abs(part)) * 10000n) / BigInt(Math.abs(whole)));
  return part < 0 !== whole < 0 ? -n : n;
}

/**
 * Format minor units per display settings. Negatives are parentheses,
 * always (DESIGN.md). No floats.
 */
export function formatMoney(minor, opts = {}) {
  const {
    symbol = '$',
    symbolSide = 'left',
    groupSeparator = ',',
    decimalSeparator = '.',
    decimalDigits = 2,
  } = opts;
  if (!Number.isInteger(minor)) throw new TypeError(`formatMoney: non-integer ${minor}`);
  const abs = Math.abs(minor);
  const div = 10 ** decimalDigits;
  const intPart = Math.floor(abs / div).toString();
  const fracPart = (abs % div).toString().padStart(decimalDigits, '0');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  const num = decimalDigits > 0 ? `${grouped}${decimalSeparator}${fracPart}` : grouped;
  const body = symbolSide === 'left' ? `${symbol} ${num}` : `${num} ${symbol}`;
  return minor < 0 ? `(${body})` : body;
}

/** Plain signed formatting for machine-readable exports (no parens). */
export function exportMoney(minor) {
  if (!Number.isInteger(minor)) throw new TypeError(`exportMoney: non-integer ${minor}`);
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.floor(abs / 100)}.${(abs % 100).toString().padStart(2, '0')}`;
}
