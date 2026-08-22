import { detectDateFormats } from '../core/dates.js';
import { parseAmountToMinor } from '../core/money.js';

const DELIMITERS = [',', ';', '\t', '|'];

/**
 * Detect the CSV delimiter: count occurrences outside quotes across the first
 * ~50 non-empty lines; highest consistent total wins, ties resolved by the
 * priority order , ; \t |. Defaults to ',' when nothing is found.
 */
export function detectDelimiter(text) {
  const lines = String(text ?? '')
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim() !== '')
    .slice(0, 50);

  const counts = new Map(DELIMITERS.map((d) => [d, 0]));
  for (const line of lines) {
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && counts.has(ch)) {
        counts.set(ch, counts.get(ch) + 1);
      }
    }
  }

  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    if (counts.get(d) > bestCount) {
      best = d;
      bestCount = counts.get(d);
    }
  }
  return best;
}

function nonEmptyCells(row) {
  return row.filter((cell) => String(cell ?? '').trim() !== '').length;
}

function hasLetters(row) {
  return row.some((cell) => /[A-Za-z]/.test(String(cell ?? '')));
}

/**
 * Heuristic header-row detection (0-based index): first row with >= 2
 * non-empty cells, at least one lettered label cell, and a following row with
 * at least as many non-empty cells. Returns 0 when nothing better is found,
 * so leading metadata junk rows are skipped automatically.
 */
export function detectHeaderRow(rows) {
  if (!Array.isArray(rows)) return 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const cur = rows[i];
    if (!Array.isArray(cur)) continue;
    const width = nonEmptyCells(cur);
    if (width < 2 || !hasLetters(cur)) continue;
    const next = rows[i + 1];
    if (!Array.isArray(next)) continue;
    if (nonEmptyCells(next) >= width) return i;
  }
  return 0;
}

/**
 * Delegate to core date-format detection. Returns
 * { candidates: ['dmy'|'mdy'|'ymd', ...], ambiguous } — ambiguity is reported,
 * never silently resolved.
 */
export function detectDateFormat(samples) {
  return detectDateFormats(samples);
}

/**
 * Detect decimal separator hint ('dot' | 'comma' | null) from amount-like
 * samples. A sample votes 'dot' only for '.' decimals of 1-2 trailing digits
 * without a comma decimal (and mirrored for comma). Mixed evidence or
 * integer-only evidence yields null + ambiguous.
 */
export function detectAmountFormat(samples) {
  let dots = 0;
  let commas = 0;

  const list = Array.isArray(samples) ? samples : [];
  for (const raw of list) {
    const s = String(raw ?? '')
      .replace(/[\s\u00A0\u202F\u2009]/g, '')
      .replace(/[$€£¥₹₩₽]/g, '')
      .replace(/^[(-]+/, '')
      .replace(/[)-]+$/, '')
      .replace(/[Cc][Rr]$/, '')
      .replace(/[Dd]$/, '');

    if (!/^\d/.test(s) || !/^[\d.,]+$/.test(s)) continue;

    let valid = false;
    for (const hint of ['dot', 'comma', null]) {
      try {
        parseAmountToMinor(s, hint);
        valid = true;
        break;
      } catch {
        // try next hint
      }
    }
    if (!valid) continue;

    const isDotDecimal = /\.\d{1,2}$/.test(s);
    const isCommaDecimal = /,\d{1,2}$/.test(s);
    if (isDotDecimal && !isCommaDecimal) dots += 1;
    else if (isCommaDecimal && !isDotDecimal) commas += 1;
  }

  if (dots > 0 && commas === 0) return { decimalHint: 'dot', ambiguous: false };
  if (commas > 0 && dots === 0) return { decimalHint: 'comma', ambiguous: false };
  return { decimalHint: null, ambiguous: true };
}

/**
 * True for trailing summary/metadata rows: first cell matches a known balance
 * label exactly and most remaining cells are empty.
 */
export function looksLikeSummaryRow(cells) {
  if (!Array.isArray(cells) || cells.length === 0) return false;
  const first = String(cells[0] ?? '').trim();
  if (!/^(total|ending balance|beginning balance|balance|summary)$/i.test(first)) return false;
  const rest = cells.slice(1);
  if (rest.length === 0) return true;
  const nonEmpty = nonEmptyCells(rest);
  return nonEmpty <= Math.max(1, Math.floor(rest.length / 2));
}
