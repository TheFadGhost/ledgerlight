import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_DB_PATH = join(process.cwd(), 'data', 'ledgerlight.db');

const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'checking'
          CHECK (type IN ('checking','savings','credit','cash')),
        currency TEXT NOT NULL DEFAULT 'USD',
        opening_balance_minor INTEGER NOT NULL DEFAULT 0
          CHECK (opening_balance_minor > -9007199254740991),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('group','expense','income')),
        exclude_from_spend INTEGER NOT NULL DEFAULT 0,
        system INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE (name, parent_id)
      );
      CREATE TABLE rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        priority INTEGER NOT NULL DEFAULT 100,
        name TEXT NOT NULL,
        match_type TEXT NOT NULL
          CHECK (match_type IN ('substring','regex','amount_range','any')),
        pattern TEXT,
        min_amount_minor INTEGER,
        max_amount_minor INTEGER,
        account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
        category_id INTEGER NOT NULL REFERENCES categories(id),
        source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','learned')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        delimiter TEXT NOT NULL,
        encoding TEXT NOT NULL DEFAULT 'utf-8',
        header_row INTEGER NOT NULL DEFAULT 0,
        date_format TEXT NOT NULL CHECK (date_format IN ('dmy','mdy','ymd')),
        column_map TEXT NOT NULL,
        amount_mode TEXT NOT NULL DEFAULT 'signed'
          CHECK (amount_mode IN ('signed','split_dc','inflow_outflow')),
        skip_patterns TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE import_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
        imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        row_count INTEGER NOT NULL,
        imported_count INTEGER NOT NULL,
        skipped_count INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        details TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        payee TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        amount_minor INTEGER NOT NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        category_source TEXT
          CHECK ((category_id IS NULL AND category_source IS NULL)
             OR (category_id IS NOT NULL AND category_source IN
                 ('rule','learned','manual','imported'))),
        applied_rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL,
        fingerprint TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        manual INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (account_id, fingerprint)
      );
      CREATE INDEX idx_txn_date ON transactions(date);
      CREATE INDEX idx_txn_account ON transactions(account_id);
      CREATE INDEX idx_txn_category ON transactions(category_id);
      CREATE INDEX idx_txn_payee ON transactions(payee);
      CREATE TABLE splits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        amount_minor INTEGER NOT NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_splits_txn ON splits(transaction_id);
      CREATE TABLE budgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL UNIQUE REFERENCES categories(id) ON DELETE CASCADE,
        monthly_amount_minor INTEGER NOT NULL CHECK (monthly_amount_minor > 0),
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE undo_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_type TEXT NOT NULL CHECK (action_type IN ('bulk_categorize','split','unsplit')),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('schema_version', '1')`,
    ).run();
  },
];

export function openDb(path = process.env.LEDGERLIGHT_DB || DEFAULT_DB_PATH) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db) {
  const hasMeta = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
    .get();
  let version = 0;
  if (hasMeta) {
    const versionRow = db
      .prepare(`SELECT value FROM meta WHERE key='schema_version'`)
      .get();
    if (versionRow) version = parseInt(versionRow.value, 10);
  }
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[version](db);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version += 1;
  }
}

export function schemaVersion(db) {
  const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
  return row ? parseInt(row.value, 10) : 0;
}
