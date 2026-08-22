// Date handling contract: dates are stored as 'YYYY-MM-DD' strings (ISO, UTC).
// All math is pure calendar arithmetic on that string form or on UTC timestamps
// — never local-timezone Date objects for storage.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const DATE_FORMATS = ['ymd', 'dmy', 'mdy'];

export class DateFormatError extends Error {
  constructor(raw, fmt) {
    super(`Cannot parse date ${JSON.stringify(raw)} as ${fmt}`);
    this.name = 'DateFormatError';
    this.raw = raw;
  }
}

/** True for real calendar dates (leap years included). */
export function isValidYmd(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = daysInMonth(y, m);
  return d <= dim;
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function splitNumeric(raw) {
  // Accept -, /, . and space as separators.
  const parts = String(raw).trim().split(/[-/. ]+/);
  if (parts.length !== 3 || parts.some((p) => !/^\d{1,4}$/.test(p))) return null;
  return parts;
}

/**
 * Strictly parse `raw` according to fmt ('ymd'|'dmy'|'mdy').
 * Two-digit years: 00-68 -> 2000-2068, 69-99 -> 1969-1999 (POSIX convention).
 * Returns 'YYYY-MM-DD' or throws DateFormatError. Never guesses.
 */
export function parseDateWithFormat(raw, fmt) {
  const parts = splitNumeric(raw);
  if (!parts) throw new DateFormatError(raw, fmt);
  let y, m, d;
  if (fmt === 'ymd') {
    [y, m, d] = parts;
  } else if (fmt === 'dmy') {
    [d, m, y] = parts;
  } else if (fmt === 'mdy') {
    [m, d, y] = parts;
  } else {
    throw new DateFormatError(raw, fmt);
  }
  y = expandYear(y);
  m = +m; d = +d;
  if (!isValidYmd(y, m, d)) throw new DateFormatError(raw, fmt);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function expandYear(y) {
  const n = +y;
  if (y.length === 2) return n <= 68 ? 2000 + n : 1900 + n;
  return n;
}

/**
 * Parse an already-validated ISO date string; throws otherwise.
 */
export function parseIsoDate(raw) {
  const mt = ISO_RE.exec(String(raw).trim());
  if (!mt) throw new DateFormatError(raw, 'iso');
  const [, y, m, d] = mt;
  if (!isValidYmd(+y, +m, +d)) throw new DateFormatError(raw, 'iso');
  return raw.trim();
}

/**
 * Given sample date strings from one column, determine which formats fit ALL
 * samples strictly. Returns { candidates: ['dmy',...], ambiguous: bool }.
 * Ambiguous means both dmy and mdy (or all three) fit — caller MUST ask the
 * user to resolve explicitly; we never pick silently.
 */
export function detectDateFormats(samples) {
  const clean = samples.map((s) => String(s ?? '').trim()).filter((s) => s !== '');
  const fits = DATE_FORMATS.filter((fmt) =>
    clean.every((s) => {
      try {
        parseDateWithFormat(s, fmt);
        return true;
      } catch {
        return false;
      }
    }),
  );
  const ambiguous = fits.includes('dmy') && fits.includes('mdy');
  return { candidates: fits, ambiguous };
}

/** Month key 'YYYY-MM' of an ISO date. */
export function monthKey(isoDate) {
  return isoDate.slice(0, 7);
}

/** Add n months to a YYYY-MM key, respecting year rollover. */
export function addMonthsToKey(key, n) {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`;
}

/** Days between two ISO dates (a - b), exact. */
export function daysBetween(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  const da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const dbb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((da - dbb) / 86400000);
}

/** Last day of month containing isoDate, as YYYY-MM-DD. */
export function endOfMonth(isoDate) {
  const [y, m, ] = isoDate.split('-').map(Number);
  const d = daysInMonth(y, m);
  return `${isoDate.slice(0, 7)}-${String(d).padStart(2, '0')}`;
}
