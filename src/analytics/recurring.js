import { daysBetween, daysInMonth } from '../core/dates.js';

// Cutoff anchor: MAX(transactions.date) in the database, not wall-clock today.
// Chosen deliberately so detection is deterministic for a given dataset no
// matter when it runs (stable for tests and reproducible for users); with live
// data max(date) tracks the present closely anyway.

const pad = (n) => String(n).padStart(2, '0');

function isoAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function isoAddMonthsClamped(iso, n) {
  let [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  y = Math.floor(total / 12);
  m = (total % 12) + 1;
  d = Math.min(d, daysInMonth(y, m));
  return `${pad(y)}-${pad(m)}-${pad(d)}`;
}

export function merchantKey(payee) {
  return String(payee).toLowerCase().replace(/[0-9]/g, '').replace(/\s+/g, ' ').trim();
}

const FAMILIES = [
  {
    name: 'weekly',
    matches: (gap) => gap >= 5 && gap <= 9,
  },
  {
    name: 'fortnightly',
    matches: (gap) => gap >= 11 && gap <= 17,
  },
  {
    name: 'monthly',
    matches: (gap, d1, d2) => {
      if (gap >= 28 && gap <= 33) return true;
      if (gap > 14) return false;
      const day1 = +d1.slice(8, 10);
      const day2 = +d2.slice(8, 10);
      if (day1 < 24 || day2 > 7) return false;
      const w = Math.abs(day1 - day2);
      return Math.min(w, 31 - w) <= 4;
    },
  },
  {
    name: 'annual',
    matches: (gap) => gap >= 355 && gap <= 375,
  },
];

function pairMatches(family, d1, d2) {
  return family.matches(daysBetween(d2, d1), d1, d2);
}

function lowerMedian(sorted) {
  return sorted[(sorted.length - 1) >> 1];
}

function withinBand(window) {
  const mags = window.map((w) => w.mag).sort((a, b) => a - b);
  const med = lowerMedian(mags);
  return window.every((w) => Math.abs(w.mag - med) * 100 <= 15 * med);
}

function betterCandidate(cand, best) {
  if (!best) return true;
  if (cand.win.length !== best.win.length) return cand.win.length > best.win.length;
  const candSpan = daysBetween(cand.win[cand.win.length - 1].date, cand.win[0].date);
  const bestSpan = daysBetween(best.win[best.win.length - 1].date, best.win[0].date);
  return candSpan > bestSpan;
}

function bestRun(items) {
  let best = null;
  for (const family of FAMILIES) {
    const n = items.length;
    for (let s = 0; s + 2 < n; s++) {
      let e = s;
      while (e + 1 < n && pairMatches(family, items[e].date, items[e + 1].date)) e++;
      for (let endIdx = e; endIdx - s + 1 >= 3; endIdx--) {
        const win = items.slice(s, endIdx + 1);
        if (!withinBand(win)) continue;
        const cand = { family: family.name, win };
        if (betterCandidate(cand, best)) best = cand;
        break;
      }
    }
  }
  return best;
}

function payeeDisplayOf(win) {
  const counts = new Map();
  for (const w of win) counts.set(w.payee, (counts.get(w.payee) ?? 0) + 1);
  let display = win[0].payee;
  let bestCount = 0;
  for (const [payee, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      display = payee;
    }
  }
  return display;
}

function buildResult(merchantKeyStr, familyName, win) {
  const mags = win.map((w) => w.mag).sort((a, b) => a - b);
  const med = lowerMedian(mags);
  const firstDate = win[0].date;
  const lastDate = win[win.length - 1].date;
  const gaps = [];
  for (let i = 1; i < win.length; i++) gaps.push(daysBetween(win[i].date, win[i - 1].date));
  const medianGapDays = lowerMedian(gaps.sort((a, b) => a - b));
  let nextExpectedDate;
  if (familyName === 'monthly') nextExpectedDate = isoAddMonthsClamped(lastDate, 1);
  else if (familyName === 'annual') nextExpectedDate = isoAddMonthsClamped(lastDate, 12);
  else nextExpectedDate = isoAddDays(lastDate, medianGapDays);
  let devSum = 0;
  for (const m of mags) devSum += Math.abs(m - med);
  const stabilityPct = Math.min(
    100,
    Math.max(0, 100 - Math.floor((devSum * 100) / (win.length * med))),
  );
  let confidence;
  if (win.length >= 5 && stabilityPct >= 85) confidence = 'high';
  else if (win.length >= 4 && stabilityPct >= 60) confidence = 'medium';
  else confidence = 'low';
  return {
    merchantKey: merchantKeyStr,
    payeeDisplay: payeeDisplayOf(win),
    cadence: familyName,
    medianAmountMinor: med,
    minAmountMinor: mags[0],
    maxAmountMinor: mags[mags.length - 1],
    occurrences: win.length,
    firstDate,
    lastDate,
    nextExpectedDate,
    stabilityPct,
    confidence,
  };
}

export function detectRecurring(db, { lookbackDays = 180 } = {}) {
  if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
    throw new TypeError('lookbackDays must be a positive integer');
  }
  const anchorRow = db.prepare('SELECT MAX(date) AS maxDate FROM transactions').get();
  if (!anchorRow || anchorRow.maxDate == null) return [];
  const cutoff = isoAddDays(anchorRow.maxDate, -lookbackDays);
  const rows = db
    .prepare(
      `
      SELECT t.date AS date, t.payee AS payee, t.amount_minor AS amountMinor
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.amount_minor < 0 AND COALESCE(c.exclude_from_spend, 0) = 0
        AND t.date >= ?
      ORDER BY t.date ASC, t.id ASC
      `,
    )
    .all(cutoff);
  const clusters = new Map();
  for (const r of rows) {
    const key = merchantKey(r.payee);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push({ date: r.date, payee: r.payee, mag: -r.amountMinor });
  }
  const results = [];
  for (const [key, items] of clusters) {
    const best = bestRun(items);
    if (best) results.push(buildResult(key, best.family, best.win));
  }
  results.sort(
    (a, b) =>
      b.occurrences - a.occurrences ||
      b.stabilityPct - a.stabilityPct ||
      (a.merchantKey < b.merchantKey ? -1 : a.merchantKey > b.merchantKey ? 1 : 0),
  );
  return results;
}
