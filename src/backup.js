// Full-database backup/restore plus transaction exports.
// Contract (docs/DATA-MODEL.md): money = integer minor units, dates =
// 'YYYY-MM-DD'. Backups are complete JSON snapshots of the eight data tables;
// operational tables (undo_log, import_files) and meta are excluded.

import { createRequire } from 'node:module';
import { parseIsoDate } from './core/dates.js';
import { exportMoney } from './core/money.js';

const require = createRequire(import.meta.url);
const APP_VERSION = require('../package.json').version;

export class BackupError extends Error {
  constructor(code, details) {
    super(`backup ${code}`);
    this.name = 'BackupError';
    this.code = code;
    this.details = details;
  }
}

const SAFE_INT_MAX = 9007199254740991;

const DATA_TABLES = [
  'accounts',
  'categories',
  'profiles',
  'rules',
  'transactions',
  'splits',
  'budgets',
  'settings',
];

// Children before parents so FK enforcement never blocks deletion.
const DELETE_ORDER = [
  'splits',
  'transactions',
  'budgets',
  'rules',
  'profiles',
  'categories',
  'accounts',
  'settings',
];

// Parents before children so FK enforcement accepts every insert.
const INSERT_ORDER = [
  'accounts',
  'categories',
  'profiles',
  'rules',
  'transactions',
  'splits',
  'budgets',
  'settings',
];

const AUTOINC_TABLES = INSERT_ORDER.filter((t) => t !== 'settings');

// Columns stored as JSON text; dumped parsed into JS values, restored by
// re-serializing non-string values.
const JSON_COLUMNS = new Map([
  ['profiles', new Set(['column_map', 'skip_patterns'])],
  ['settings', new Set(['value'])],
]);

const isSafeInt = (v) => Number.isInteger(v) && Math.abs(v) <= SAFE_INT_MAX;

const ISO_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const KINDS = {
  int: (v) => isSafeInt(v),
  posInt: (v) => isSafeInt(v) && v > 0,
  nullableInt: (v) => v === null || isSafeInt(v),
  nullablePosInt: (v) => v === null || (isSafeInt(v) && v > 0),
  str: (v) => typeof v === 'string',
  nonEmptyStr: (v) => typeof v === 'string' && v.length > 0,
  nullableStr: (v) => v === null || typeof v === 'string',
  isoDate: (v) => {
    if (typeof v !== 'string' || !ISO_YMD_RE.test(v)) return false;
    try {
      parseIsoDate(v);
      return true;
    } catch {
      return false;
    }
  },
  json: (v) =>
    (typeof v === 'string' && v.length > 0) ||
    (v !== null && typeof v === 'object'),
};

// Per-table validation spec: `required` fields must be present and valid
// (mirrors NOT NULL constraints), `optional` fields are validated only when
// present. Enum arrays mirror schema CHECK constraints.
const TABLE_SPECS = {
  accounts: {
    pk: 'id',
    columns: ['id', 'name', 'type', 'currency', 'opening_balance_minor', 'created_at'],
    required: {
      id: 'posInt',
      name: 'nonEmptyStr',
      type: ['checking', 'savings', 'credit', 'cash'],
      currency: 'nonEmptyStr',
      opening_balance_minor: 'int',
      created_at: 'str',
    },
    optional: {},
  },
  categories: {
    pk: 'id',
    columns: ['id', 'name', 'parent_id', 'kind', 'exclude_from_spend', 'system', 'sort_order'],
    required: {
      id: 'posInt',
      name: 'nonEmptyStr',
      kind: ['group', 'expense', 'income'],
      exclude_from_spend: 'int',
      system: 'int',
      sort_order: 'int',
    },
    optional: { parent_id: 'nullablePosInt' },
  },
  profiles: {
    pk: 'id',
    columns: [
      'id', 'name', 'delimiter', 'encoding', 'header_row', 'date_format',
      'column_map', 'amount_mode', 'skip_patterns', 'updated_at',
    ],
    required: {
      id: 'posInt',
      name: 'nonEmptyStr',
      delimiter: 'nonEmptyStr',
      encoding: 'str',
      header_row: 'int',
      date_format: ['dmy', 'mdy', 'ymd'],
      column_map: 'json',
      amount_mode: ['signed', 'split_dc', 'inflow_outflow'],
      skip_patterns: 'json',
      updated_at: 'str',
    },
    optional: {},
  },
  rules: {
    pk: 'id',
    columns: [
      'id', 'priority', 'name', 'match_type', 'pattern', 'min_amount_minor',
      'max_amount_minor', 'account_id', 'category_id', 'source', 'enabled',
      'created_at',
    ],
    required: {
      id: 'posInt',
      priority: 'int',
      name: 'nonEmptyStr',
      match_type: ['substring', 'regex', 'amount_range', 'any'],
      category_id: 'posInt',
      source: ['user', 'learned'],
      enabled: 'int',
      created_at: 'str',
    },
    optional: {
      pattern: 'nullableStr',
      min_amount_minor: 'nullableInt',
      max_amount_minor: 'nullableInt',
      account_id: 'nullablePosInt',
    },
  },
  transactions: {
    pk: 'id',
    columns: [
      'id', 'account_id', 'date', 'payee', 'description', 'amount_minor',
      'category_id', 'category_source', 'applied_rule_id', 'fingerprint',
      'notes', 'manual', 'created_at',
    ],
    required: {
      id: 'posInt',
      account_id: 'posInt',
      date: 'isoDate',
      payee: 'str',
      description: 'str',
      amount_minor: 'int',
      fingerprint: 'nonEmptyStr',
      notes: 'str',
      manual: 'int',
      created_at: 'str',
    },
    optional: {
      category_id: 'nullablePosInt',
      category_source: (v) =>
        v === null || ['rule', 'learned', 'manual', 'imported'].includes(v),
      applied_rule_id: 'nullablePosInt',
    },
  },
  splits: {
    pk: 'id',
    columns: ['id', 'transaction_id', 'amount_minor', 'category_id', 'note'],
    required: {
      id: 'posInt',
      transaction_id: 'posInt',
      amount_minor: 'int',
      note: 'str',
    },
    optional: { category_id: 'nullablePosInt' },
  },
  budgets: {
    pk: 'id',
    columns: ['id', 'category_id', 'monthly_amount_minor', 'enabled'],
    required: {
      id: 'posInt',
      category_id: 'posInt',
      monthly_amount_minor: (v) => isSafeInt(v) && v > 0,
      enabled: 'int',
    },
    optional: {},
  },
  settings: {
    pk: 'key',
    columns: ['key', 'value'],
    required: { key: 'nonEmptyStr', value: 'json' },
    optional: {},
  },
};

function resolveCheck(spec) {
  if (Array.isArray(spec)) return (v) => spec.includes(v);
  if (typeof spec === 'string') return KINDS[spec];
  return spec;
}

function tryParseJson(text) {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Full snapshot of the eight data tables; operational tables excluded. */
export function createBackup(db) {
  const data = {};
  for (const table of DATA_TABLES) {
    const orderBy = table === 'settings' ? 'key' : 'id';
    let rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
    const jsonCols = JSON_COLUMNS.get(table);
    if (jsonCols) {
      rows = rows.map((row) => {
        const out = { ...row };
        for (const col of jsonCols) out[col] = tryParseJson(row[col]);
        return out;
      });
    }
    data[table] = rows;
  }
  return {
    app: 'ledgerlight',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    schemaVersion: schemaVersionOf(db),
    data,
  };
}

function schemaVersionOf(db) {
  const row = db
    .prepare(`SELECT value FROM meta WHERE key='schema_version'`)
    .get();
  return row ? parseInt(row.value, 10) : 0;
}

/**
 * Validate structure and every row WITHOUT touching the database; on success
 * replace all data tables atomically in one transaction. Returns per-table
 * restored row counts. meta/schema_version are never modified.
 */
export function restoreBackup(db, backupObj) {
  if (backupObj === null || typeof backupObj !== 'object' || Array.isArray(backupObj)) {
    throw new BackupError('INVALID_BACKUP', { problem: 'backup must be an object' });
  }
  if (backupObj.app !== 'ledgerlight') {
    throw new BackupError('INVALID_BACKUP', {
      problem: 'app must be "ledgerlight"',
      got: backupObj.app ?? null,
    });
  }
  const currentVersion = schemaVersionOf(db);
  const sv = backupObj.schemaVersion;
  if (typeof sv !== 'number' || !Number.isInteger(sv)) {
    throw new BackupError('INVALID_BACKUP', {
      problem: 'schemaVersion must be an integer',
      got: sv ?? null,
    });
  }
  if (sv > currentVersion) {
    throw new BackupError('SCHEMA_NEWER', { backup: sv, current: currentVersion });
  }

  const rawData = backupObj.data;
  if (rawData === null || typeof rawData !== 'object') {
    throw new BackupError('INVALID_BACKUP', { problem: 'data must be an object' });
  }
  const badTables = [];
  for (const table of DATA_TABLES) {
    if (!Array.isArray(rawData[table])) badTables.push(table);
  }
  if (badTables.length > 0) {
    throw new BackupError('INVALID_BACKUP', {
      problem: 'data tables must be arrays',
      tables: badTables,
    });
  }

  // Validate everything up front; nothing is written until all rows pass.
  const problems = [];
  for (const table of INSERT_ORDER) {
    const spec = TABLE_SPECS[table];
    rawData[table].forEach((row, index) => {
      problems.push(
        ...validateRow(table, spec, row, index),
      );
    });
  }
  if (problems.length > 0) {
    throw new BackupError('INVALID_ROW', problems);
  }

  db.exec('BEGIN');
  let committed = false;
  try {
    for (const table of DELETE_ORDER) {
      db.prepare(`DELETE FROM ${table}`).run();
    }

    for (const table of INSERT_ORDER) {
      const spec = TABLE_SPECS[table];
      const jsonCols = JSON_COLUMNS.get(table) ?? new Set();
      // Cache per column-shape since rows may omit optional columns.
      const insertCache = new Map();
      for (const rawRow of rawData[table]) {
        const cols = spec.columns.filter((c) => rawRow[c] !== undefined);
        const values = cols.map((c) => {
          const v = rawRow[c];
          return jsonCols.has(c) && (v === null || typeof v !== 'string')
            ? JSON.stringify(v)
            : v;
        });
        let stmt = insertCache.get(cols.join(','));
        if (!stmt) {
          stmt = db.prepare(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          );
          insertCache.set(cols.join(','), stmt);
        }
        stmt.run(...values);
      }
    }

    // Keep AUTOINCREMENT counters consistent with the restored ids: after a
    // DELETE the old seq survives, and smaller explicit ids never lower it.
    for (const table of AUTOINC_TABLES) {
      const maxId = db
        .prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`)
        .get().m;
      const updated = db
        .prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = ?`)
        .run(maxId, table);
      if (updated.changes === 0) {
        db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`).run(
          table,
          maxId,
        );
      }
    }

    db.exec('COMMIT');
    committed = true;
  } catch (txErr) {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* no active txn */ }
    }
    throw new BackupError('INVALID_ROW', {
      phase: 'transaction',
      message: String(txErr && txErr.message ? txErr.message : txErr),
    });
  }

  const restored = {};
  for (const table of DATA_TABLES) restored[table] = rawData[table].length;
  return { restored };
}

function validateRow(table, spec, row, index) {
  const where = { table, index };
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return [{ ...where, problem: 'row must be an object' }];
  }
  const problems = [];
  for (const [field, checkSpec] of Object.entries(spec.required)) {
    const value = row[field];
    if (value === undefined) {
      problems.push({ ...where, id: row.id ?? null, field, problem: 'missing required field' });
      continue;
    }
    if (!resolveCheck(checkSpec)(value)) {
      problems.push({
        ...where,
        id: row.id ?? row.key ?? null,
        field,
        problem: `invalid ${field}`,
        got: value,
      });
    }
  }
  for (const [field, checkSpec] of Object.entries(spec.optional)) {
    const value = row[field];
    if (value === undefined) continue;
    if (!resolveCheck(checkSpec)(value)) {
      problems.push({
        ...where,
        id: row.id ?? null,
        field,
        problem: `invalid ${field}`,
        got: value,
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Transaction exports
// ---------------------------------------------------------------------------

const EXPORT_SELECT = `
  SELECT t.id, t.date, t.payee, t.description, t.amount_minor,
         c.name AS category_name, c.id AS category_id, a.name AS account_name
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id`;

function exportRows(db, filters = {}) {
  const conds = [];
  const params = [];
  if (filters.accountId != null) {
    conds.push('t.account_id = ?');
    params.push(filters.accountId);
  }
  if (filters.categoryId != null) {
    conds.push('t.category_id = ?');
    params.push(filters.categoryId);
  }
  if (filters.from != null) {
    conds.push('t.date >= ?');
    params.push(filters.from);
  }
  if (filters.to != null) {
    conds.push('t.date <= ?');
    params.push(filters.to);
  }
  const sql =
    EXPORT_SELECT +
    (conds.length ? ` WHERE ${conds.join(' AND ')}` : '') +
    ' ORDER BY t.date, t.id';
  return db.prepare(sql).all(...params);
}

/** RFC4180 escaping: quote only when needed; double embedded quotes. */
function csvEscape(value) {
  const s = String(value);
  return /["\r\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV export: date,payee,description,amount,category,account.
 * Amounts are plain signed decimals (exportMoney), never parentheses.
 * Category is the leaf category name or empty when uncategorized.
 */
export function exportTransactionsCsv(db, filters = {}) {
  const lines = ['date,payee,description,amount,category,account'];
  for (const r of exportRows(db, filters)) {
    lines.push(
      [
        r.date,
        csvEscape(r.payee),
        csvEscape(r.description),
        exportMoney(r.amount_minor),
        csvEscape(r.category_name ?? ''),
        csvEscape(r.account_name),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** JSON export rows for the API surface (GET /api/export.json). */
export function exportTransactionsJson(db, filters = {}) {
  return exportRows(db, filters).map((r) => ({
    id: r.id,
    date: r.date,
    payee: r.payee,
    description: r.description,
    amountMinor: r.amount_minor,
    ...(r.category_id != null ? { categoryId: r.category_id } : {}),
    accountName: r.account_name,
  }));
}
