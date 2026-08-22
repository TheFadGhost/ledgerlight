import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openDb } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import {
  createBackup,
  restoreBackup,
  BackupError,
  exportTransactionsCsv,
  exportTransactionsJson,
} from '../src/backup.js';
import { parseCsv } from '../src/csv/parse.js';
import { exportMoney } from '../src/core/money.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

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

function insertTxn(
  db,
  accountId,
  {
    date,
    payee,
    description = '',
    amountMinor,
    categoryId = null,
    categorySource = null,
    fingerprint,
    createdAt = '2026-02-01T09:00:00.000Z',
    notes = '',
    manual = 0,
  },
) {
  return Number(
    db
      .prepare(
        `INSERT INTO transactions
           (account_id, date, payee, description, amount_minor, category_id,
            category_source, fingerprint, notes, manual, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        accountId,
        date,
        payee,
        description,
        amountMinor,
        categoryId,
        categorySource,
        fingerprint,
        notes,
        manual,
        createdAt,
      ).lastInsertRowid,
  );
}

// Rich database: accounts, full taxonomy (+2 default rules), transactions with
// splits, a custom rule, a profile, a budget, a setting — plus operational
// rows that must NOT be part of backups.
function makeRichDb() {
  const db = openDb(':memory:');
  const cats = seedTaxonomy(db);
  const acctA = Number(
    db
      .prepare(
        `INSERT INTO accounts (name, type, currency, opening_balance_minor, created_at)
         VALUES ('Checking', 'checking', 'USD', 10000, '2026-01-01T00:00:00.000Z')`,
      )
      .run().lastInsertRowid,
  );
  const acctB = Number(
    db
      .prepare(
        `INSERT INTO accounts (name, type, currency, opening_balance_minor, created_at)
         VALUES ('Visa', 'credit', 'USD', -50000, '2026-01-01T00:00:01.000Z')`,
      )
      .run().lastInsertRowid,
  );

  insertTxn(db, acctA, {
    date: '2026-02-03',
    payee: 'Acme, Inc "Big"',
    description: 'weekly run, incl. tax',
    amountMinor: -4523,
    categoryId: cats.get('Groceries'),
    categorySource: 'manual',
    manual: 1,
    fingerprint: 'fp-1',
  });
  insertTxn(db, acctB, {
    date: '2026-02-05',
    payee: 'Payroll Co',
    amountMinor: 250000,
    categoryId: cats.get('Salary'),
    categorySource: 'rule',
    fingerprint: 'fp-2',
    createdAt: '2026-02-05T10:00:00.000Z',
  });
  const splitTxnId = insertTxn(db, acctA, {
    date: '2026-02-10',
    payee: 'Superstore One',
    amountMinor: -999,
    fingerprint: 'fp-3',
  });
  db.prepare(
    `INSERT INTO splits (transaction_id, amount_minor, category_id, note)
     VALUES (?, ?, ?, ?)`,
  ).run(splitTxnId, -500, cats.get('Groceries'), 'food');
  db.prepare(
    `INSERT INTO splits (transaction_id, amount_minor, category_id, note)
     VALUES (?, ?, ?, ?)`,
  ).run(splitTxnId, -499, cats.get('Entertainment'), 'fun');

  db.prepare(
    `INSERT INTO rules
       (priority, name, match_type, pattern, min_amount_minor, max_amount_minor,
        account_id, category_id, source, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'user', 1, ?)`,
  ).run(
    50,
    'Restaurant spend',
    'substring',
    'bistro',
    -10000,
    acctA,
    cats.get('Restaurants & Cafes'),
    '2026-02-02T08:00:00.000Z',
  );

  db.prepare(
    `INSERT INTO profiles
       (name, delimiter, encoding, header_row, date_format, column_map,
        amount_mode, skip_patterns, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'Chase Card',
    ',',
    'utf-8',
    1,
    'mdy',
    JSON.stringify({ date: '0', payee: '2', amount: '4' }),
    'signed',
    JSON.stringify(['^INTEREST', '^TOTAL']),
    '2026-02-01T12:00:00.000Z',
  );

  db.prepare(
    `INSERT INTO budgets (category_id, monthly_amount_minor, enabled) VALUES (?, ?, 1)`,
  ).run(cats.get('Groceries'), 40000);

  db.prepare(`INSERT INTO settings (key, value) VALUES ('theme', ?)`).run(
    JSON.stringify({ theme: 'dark', weekStart: 1 }),
  );

  // Operational tables: exist but are excluded from backups.
  db.prepare(
    `INSERT INTO undo_log (action_type, payload) VALUES ('split', ?)`,
  ).run(JSON.stringify({ transactionId: splitTxnId }));
  db.prepare(
    `INSERT INTO import_files
       (filename, profile_id, row_count, imported_count, skipped_count, error_count, details)
     VALUES ('statement.csv', 1, 100, 90, 9, 1, '{}')`,
  ).run();

  return { db, cats, acctA, acctB };
}

/** Canonical dump of the eight data tables, sorted table+id (settings by key). */
function snapshot(db) {
  const snap = {};
  for (const table of DATA_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    rows.sort((a, b) =>
      String(a.id ?? a.key).localeCompare(String(b.id ?? b.key), 'en', { numeric: true }),
    );
    snap[table] = rows;
  }
  return snap;
}

const COUNT_SQL = DATA_TABLES.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t}`).join(
  ' UNION ALL ',
);

function counts(db) {
  return Object.fromEntries(db.prepare(COUNT_SQL).all().map((r) => [r.t, r.n]));
}

test('createBackup: shape, version from package.json, parsed JSON columns, exclusions', () => {
  const { db, cats } = makeRichDb();
  const backup = createBackup(db);

  assert.equal(backup.app, 'ledgerlight');
  assert.equal(backup.version, pkg.version);
  assert.equal(typeof backup.exportedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(backup.exportedAt)), 'exportedAt parses as datetime');
  assert.ok(backup.exportedAt.endsWith('Z'), 'exportedAt is UTC');
  assert.equal(backup.schemaVersion, 1);

  assert.deepEqual(Object.keys(backup.data).sort(), [...DATA_TABLES].sort());
  assert.ok(!('undo_log' in backup.data));
  assert.ok(!('import_files' in backup.data));

  // Operational tables had rows; they must be excluded entirely.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM undo_log').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_files').get().n, 1);

  assert.equal(backup.data.accounts.length, 2);
  assert.equal(backup.data.categories.length, 21);
  assert.equal(backup.data.transactions.length, 3);
  assert.equal(backup.data.splits.length, 2);
  assert.equal(backup.data.rules.length, 3); // 2 default + 1 custom
  assert.equal(backup.data.profiles.length, 1);
  assert.equal(backup.data.budgets.length, 1);
  assert.equal(backup.data.settings.length, 1);

  // Ordered by id.
  for (const table of DATA_TABLES) {
    if (table === 'settings') continue;
    const ids = backup.data[table].map((r) => r.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), `${table} ordered by id`);
  }

  // JSON text stored as parsed objects.
  assert.deepEqual(backup.data.profiles[0].column_map, {
    date: '0',
    payee: '2',
    amount: '4',
  });
  assert.deepEqual(backup.data.profiles[0].skip_patterns, ['^INTEREST', '^TOTAL']);
  assert.deepEqual(backup.data.settings[0], {
    key: 'theme',
    value: { theme: 'dark', weekStart: 1 },
  });

  // Money stays integer minor units.
  const acme = backup.data.transactions.find((t) => t.fingerprint === 'fp-1');
  assert.equal(acme.amount_minor, -4523);
  assert.equal(acme.category_id, cats.get('Groceries'));
});

test('round-trip: restore into fresh db yields identical snapshot', () => {
  const A = makeRichDb();
  const backup = createBackup(A.db);

  const B = openDb(':memory:');
  const { restored } = restoreBackup(B, backup);
  assert.deepEqual(restored, {
    accounts: 2,
    categories: 21,
    profiles: 1,
    rules: 3,
    transactions: 3,
    splits: 2,
    budgets: 1,
    settings: 1,
  });

  assert.deepEqual(snapshot(A.db), snapshot(B), 'sorted snapshots equal');

  // meta untouched.
  assert.equal(
    B.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get().value,
    '1',
  );

  // Autoincrement continues after the restored max id.
  const nextId = Number(
    B.prepare(`INSERT INTO accounts (name, type) VALUES ('After Restore', 'cash')`).run()
      .lastInsertRowid,
  );
  assert.equal(nextId, 3);
});

test('restore rejects newer schemaVersion without writing anything', () => {
  const A = makeRichDb();
  const backup = createBackup(A.db);
  const target = makeRichDb();
  const before = counts(target.db);

  assert.throws(
    () =>
      restoreBackup(target.db, {
        ...structuredClone(backup),
        schemaVersion: backup.schemaVersion + 1,
      }),
    (err) => err instanceof BackupError && err.code === 'SCHEMA_NEWER',
  );
  assert.deepEqual(counts(target.db), before, 'nothing written on schema rejection');

  assert.throws(
    () => restoreBackup(target.db, { ...backup, app: 'other-app' }),
    (err) => err instanceof BackupError && err.code === 'INVALID_BACKUP',
  );
  assert.throws(() => restoreBackup(target.db, null), (err) => err instanceof BackupError);
  const noRules = structuredClone(backup);
  delete noRules.data.rules;
  assert.throws(
    () => restoreBackup(target.db, noRules),
    (err) =>
      err instanceof BackupError &&
      err.code === 'INVALID_BACKUP' &&
      err.details.tables.includes('rules'),
  );
  assert.deepEqual(counts(target.db), before);
});

test('restore rejects tampered rows before writing anything', () => {
  const A = makeRichDb();
  const backup = createBackup(A.db);

  const cases = [
    { name: "bad date '2026-13-40'", mutate: (b) => { b.data.transactions[0].date = '2026-13-40'; } },
    { name: 'float amount 1.5', mutate: (b) => { b.data.splits[0].amount_minor = 1.5; } },
    { name: 'missing fingerprint', mutate: (b) => { b.data.transactions[0].fingerprint = ''; } },
    { name: 'missing required field', mutate: (b) => { delete b.data.budgets[0].monthly_amount_minor; } },
    { name: 'bad enum', mutate: (b) => { b.data.accounts[0].type = 'mattress'; } },
  ];

  for (const c of cases) {
    const target = makeRichDb();
    const before = counts(target.db);
    const tampered = structuredClone(backup);
    c.mutate(tampered);

    assert.throws(
      () => restoreBackup(target.db, tampered),
      (err) => err instanceof BackupError && err.code === 'INVALID_ROW',
      `case: ${c.name}`,
    );
    assert.deepEqual(counts(target.db), before, `nothing written for case: ${c.name}`);
  }
});

test('restore into existing data fully replaces it (extra rows gone, sequence resynced)', () => {
  const A = makeRichDb();
  const backup = createBackup(A.db);

  const target = makeRichDb();
  target.db
    .prepare(`INSERT INTO accounts (id, name, type, currency, opening_balance_minor, created_at)
              VALUES (5000, 'Ghost', 'checking', 'USD', 0, '2026-03-01T00:00:00.000Z')`)
    .run();

  restoreBackup(target.db, backup);

  assert.deepEqual(snapshot(A.db), snapshot(target.db), 'replaced exactly with source data');
  const names = target.db.prepare('SELECT name FROM accounts ORDER BY id').all().map((r) => r.name);
  assert.ok(!names.includes('Ghost'), 'pre-existing extra row gone');

  // sqlite_sequence was stale at 5000; resync makes next id follow restored max.
  const nextId = Number(
    target.db
      .prepare(`INSERT INTO accounts (name, type) VALUES ('Post Replace', 'savings')`)
      .run().lastInsertRowid,
  );
  assert.equal(nextId, 3);
});

test('exportTransactionsCsv: RFC4180 quoting round-trips through parseCsv', () => {
  const { db } = makeRichDb();
  const csv = exportTransactionsCsv(db);

  const { rows } = parseCsv(csv, { delimiter: ',' });
  assert.equal(rows[0].join(','), 'date,payee,description,amount,category,account');
  assert.equal(rows.length, 4); // header + 3 transactions

  const byFp = new Map();
  for (const r of rows.slice(1)) byFp.set(r[1], r);

  const acme = byFp.get('Acme, Inc "Big"');
  assert.ok(acme, 'comma+quote payee survives quoting');
  assert.equal(acme[2], 'weekly run, incl. tax');
  assert.equal(acme[3], '-45.23', 'expense is plain signed decimal, no parentheses');
  assert.equal(acme[4], 'Groceries', 'leaf category name');
  assert.equal(acme[5], 'Checking');

  const payroll = byFp.get('Payroll Co');
  assert.equal(payroll[3], '2500.00', 'income positive plain decimal');

  const uncategorized = byFp.get('Superstore One');
  assert.equal(uncategorized[4], '', 'uncategorized -> empty category');

  assert.ok(!csv.includes('('), 'no parentheses anywhere in export');
});

test('exportTransactionsCsv: filters by account, category, from/to', () => {
  const { db, cats, acctA, acctB } = makeRichDb();

  assert.equal(exportTransactionsCsv(db, { accountId: acctA }).trimEnd().split('\n').length - 1, 2);
  assert.equal(exportTransactionsCsv(db, { accountId: acctB }).trimEnd().split('\n').length - 1, 1);
  assert.equal(
    exportTransactionsCsv(db, { categoryId: cats.get('Groceries') }).trimEnd().split('\n').length - 1,
    1,
  );
  const ranged = exportTransactionsCsv(db, { from: '2026-02-05', to: '2026-02-10' });
  assert.equal(ranged.trimEnd().split('\n').length - 1, 2);
  assert.match(ranged, /Payroll Co/);
  assert.match(ranged, /Superstore One/);
  assert.ok(!ranged.includes('Acme'));
});

test('exportTransactionsJson: field mapping, optional categoryId, accountName', () => {
  const { db, cats, acctA } = makeRichDb();
  const rows = exportTransactionsJson(db);

  assert.equal(rows.length, 3);
  const acme = rows.find((r) => r.payee === 'Acme, Inc "Big"');
  assert.deepEqual(acme, {
    id: 1,
    date: '2026-02-03',
    payee: 'Acme, Inc "Big"',
    description: 'weekly run, incl. tax',
    amountMinor: -4523,
    categoryId: cats.get('Groceries'),
    accountName: 'Checking',
  });
  const uncategorized = rows.find((r) => r.payee === 'Superstore One');
  assert.equal('categoryId' in uncategorized, false, 'categoryId omitted when uncategorized');
  assert.ok(rows.every((r) => typeof r.accountName === 'string'));

  const filtered = exportTransactionsJson(db, { accountId: acctA, from: '2026-02-10' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].payee, 'Superstore One');
});

test('exportMoney sign convention: negatives stay plain "-12.34"', () => {
  assert.equal(exportMoney(-1234), '-12.34');
  assert.equal(exportMoney(1234), '12.34');
  assert.equal(exportMoney(0), '0.00');
});
