import { createHash } from 'node:crypto';

const NOISE_PREFIX = /^(?:(?:debit\s+)?card\s+purchase|debit\s+card|pos)\s+/;

function stripNoise(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(NOISE_PREFIX, '');
  } while (s !== prev);
  return s;
}

function normalizePart(s) {
  return stripNoise(
    String(s ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}&\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export function normalizePayee(payee, description = '') {
  const base = normalizePart(payee);
  const desc = normalizePart(description);
  if (!desc || base === desc || base.includes(desc)) return base;
  return base ? `${base} | ${desc}` : desc;
}

export function fingerprint({ accountId, date, amountMinor, payee, description }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError(`date must be 'YYYY-MM-DD', got: ${JSON.stringify(date)}`);
  }
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(`amountMinor must be an integer, got: ${JSON.stringify(amountMinor)}`);
  }
  const key = `${accountId}|${date}|${amountMinor}|${normalizePayee(payee, description)}`;
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Occurrence-qualified fingerprint: ordinal 0 keeps the plain hash so single
 * purchases stay canonical; repeated identical rows (two real same-day
 * purchases with identical everything) get '#1', '#2', ... suffixes so both
 * persist under UNIQUE(account_id, fingerprint).
 */
export function qualifyFingerprint(fp, ordinal) {
  return ordinal === 0 ? fp : `${fp}#${ordinal}`;
}

/**
 * Count-difference overlap rule (docs/DATA-MODEL.md): per fingerprint group
 * with K rows already stored and M incoming, skip min(K,M) — always the FIRST
 * ones in stable file order — and insert the remaining M-K with ordinals
 * K..M-1. Returns inserts augmented with their final fingerprint string;
 * performs no writes itself.
 */
export function planImport(db, accountId, incomingRows) {
  const counts = new Map();
  if (incomingRows.length > 0) {
    // Stored fingerprints may carry '#n' occurrence suffixes; strip them so
    // group counts reflect true occurrences per base fingerprint.
    for (const r of db
      .prepare(`SELECT fingerprint FROM transactions WHERE account_id = ?`)
      .all(accountId)) {
      const base = r.fingerprint.replace(/#\d+$/, '');
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
  }

  const groups = new Map();
  const fpByIndex = new Array(incomingRows.length);
  for (let i = 0; i < incomingRows.length; i += 1) {
    const row = incomingRows[i];
    const fp = fingerprint({
      accountId,
      date: row.date,
      amountMinor: row.amountMinor,
      payee: row.payee,
      description: row.description,
    });
    fpByIndex[i] = fp;
    let g = groups.get(fp);
    if (!g) {
      g = [];
      groups.set(fp, g);
    }
    g.push(i);
  }

  // ordinal assignment per group position: existingK + j
  const finalFpByIndex = new Array(incomingRows.length);
  const skipAt = new Set();
  for (const [fp, indices] of groups) {
    const k = Math.min(counts.get(fp) ?? 0, indices.length);
    indices.forEach((rowIdx, j) => {
      if (j < k) {
        skipAt.add(rowIdx);
      }
      finalFpByIndex[rowIdx] = qualifyFingerprint(fp, j);
    });
  }

  const inserts = [];
  const skipped = [];
  for (let i = 0; i < incomingRows.length; i += 1) {
    if (skipAt.has(i)) {
      skipped.push({ rowIndex: i, reason: 'duplicate', fingerprint: finalFpByIndex[i] });
    } else {
      inserts.push({ ...incomingRows[i], fingerprint: finalFpByIndex[i] });
    }
  }

  return { inserts, skipped };
}
