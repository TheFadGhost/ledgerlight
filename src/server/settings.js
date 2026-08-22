import { withTransaction } from '../core/db.js';

const THEMES = new Set(['light', 'dark', 'high-contrast']);

const DEFAULTS = {
  theme: 'light',
  display: {
    currency: 'USD',
    symbol: '$',
    symbolSide: 'left',
    groupSeparator: ',',
    decimalSeparator: '.',
    decimalDigits: 2,
  },
};

export function getSettings(db) {
  const stored = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // ignore malformed rows, fall back to defaults
    }
  }
  return {
    ...DEFAULTS,
    ...stored,
    display: { ...DEFAULTS.display, ...(stored.display && typeof stored.display === 'object' ? stored.display : {}) },
  };
}

export function putSettings(db, body) {
  const current = getSettings(db);
  const next = {
    ...current,
    ...(body ?? {}),
    display: { ...current.display, ...((body?.display && typeof body.display === 'object') ? body.display : {}) },
  };

  if (!THEMES.has(next.theme)) throw err(400, 'INVALID_THEME', `theme must be one of ${[...THEMES].join(', ')}`);
  const d = next.display;
  if (!/^[A-Z]{3}$/.test(String(d.currency || ''))) throw err(400, 'INVALID_CURRENCY', 'display.currency must be a 3-letter code');
  if (typeof d.symbol !== 'string' || d.symbol.length > 3) throw err(400, 'INVALID_SYMBOL', 'display.symbol must be 1-3 chars');
  if (!['left', 'right'].includes(d.symbolSide)) throw err(400, 'INVALID_SYMBOL_SIDE', 'symbolSide must be left or right');
  for (const k of ['groupSeparator', 'decimalSeparator']) {
    if (typeof d[k] !== 'string' || d[k].length > 1) throw err(400, 'INVALID_SEPARATOR', `${k} must be a single character`);
  }
  if (!Number.isInteger(d.decimalDigits) || d.decimalDigits < 0 || d.decimalDigits > 4) {
    throw err(400, 'INVALID_DIGITS', 'decimalDigits must be an integer 0-4');
  }

  const set = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  );
  withTransaction(db, () => {
    set.run('theme', JSON.stringify(next.theme));
    set.run('display', JSON.stringify(next.display));
  });
  return next;
}

function err(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
