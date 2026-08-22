import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import { normalizePayee, fingerprint, planImport } from '../src/dedupe.js';

function setup() {
  const db = openDb(':memory:');
  seedTaxonomy(db);
  const res = db
    .prepare(`INSERT INTO accounts (name, type, currency) VALUES ('Test', 'checking', 'USD')`)
    .run();
  const accountId = Number(res.lastInsertRowid);
  return { db, accountId };
}

function insertTxn(db, accountId, { date, payee, description = '', amountMinor }) {
  return db
    .prepare(
      `INSERT INTO transactions (account_id, date, payee, description, amount_minor, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(accountId, date, payee, description, amountMinor, fingerprint({ accountId, date, amountMinor, payee, description }));
}

function txnCount(db, accountId) {
  return db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(accountId).n;
}

test('normalizePayee: lowercase + whitespace collapse + trim', () => {
  assert.equal(normalizePayee('  STARBUCKS   Store #42 '), 'starbucks store 42');
});

test('normalizePayee: strips punctuation but keeps &', () => {
  assert.equal(normalizePayee('BARNES & NOBLE, INC.'), 'barnes & noble inc');
  assert.equal(normalizePayee('ACME - CORP (LLC)'), 'acme corp llc');
  assert.match(normalizePayee('JOHNSON & JOHNSON'), /&/);
});

test('normalizePayee: strips common noise prefixes', () => {
  assert.equal(normalizePayee('POS 12345 COFFEE SHOP'), '12345 coffee shop');
  assert.equal(normalizePayee('Debit Card Purchase GROCERY'), 'grocery');
  assert.equal(normalizePayee('CARD PURCHASE ONLINE STORE'), 'online store');
});

test('normalizePayee: combines description with separator when meaningful', () => {
  assert.equal(normalizePayee('Amazon', 'Order 123'), 'amazon | order 123');
});

test('normalizePayee: does not duplicate redundant description', () => {
  const combined = normalizePayee('Amazon Order 123', 'order 123');
  assert.ok(!combined.includes('|'), `expected no separator, got ${combined}`);
  const same = normalizePayee('amazon', 'AMAZON');
  assert.equal(same, 'amazon');
  const emptyDesc = normalizePayee('amazon', '   ');
  assert.equal(emptyDesc, 'amazon');
});

test('fingerprint: stable for identical inputs', () => {
  const a = fingerprint({ accountId: 1, date: '2026-01-15', amountMinor: -4200, payee: 'Kroger' });
  const b = fingerprint({ accountId: 1, date: '2026-01-15', amountMinor: -4200, payee: 'kroger' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

const base = { accountId: 1, date: '2026-01-15', amountMinor: -1000, payee: 'Store', description: '' };
const variantOf = (over) => fingerprint({ ...base, ...over });

test('fingerprint: changes when account/date/amount/payee/description change', () => {
  const ref = variantOf({});
  assert.notEqual(ref, variantOf({ accountId: 2 }), 'accountId change must change hash');
  assert.notEqual(ref, variantOf({ date: '2026-01-16' }), 'date change must change hash');
  assert.notEqual(ref, variantOf({ amountMinor: -2000 }), 'amount change must change hash');
  assert.notEqual(ref, variantOf({ payee: 'Other Store' }), 'payee change must change hash');
  assert.notEqual(ref, variantOf({ description: 'note x' }), 'description change must change hash');
});

test('fingerprint: near-duplicates differing only in noise stay equal', () => {
  assert.equal(
    fingerprint({ ...base, payee: 'POS Store' }),
    fingerprint({ ...base, payee: 'store' }),
  );
});

test('fingerprint: rejects bad inputs', () => {
  assert.throws(() => fingerprint({ ...base, date: '01/15/2026' }), TypeError);
  assert.throws(() => fingerprint({ ...base, date: '2026-1-5' }), TypeError);
  assert.throws(() => fingerprint({ ...base, amountMinor: -10.5 }), TypeError);
  assert.throws(() => fingerprint({ ...base, amountMinor: '-10' }), TypeError);
});

test('planImport: fresh DB imports all rows including two identical same-day purchases', () => {
  const { db, accountId } = setup();
  const row = { date: '2026-03-01', payee: 'Coffee Bar', description: '', amountMinor: -450 };
  const plan = planImport(db, accountId, [row, { ...row }]);
  assert.equal(plan.inserts.length, 2);
  assert.deepEqual(plan.skipped, []);
});

test('planImport: two same-day same-merchant purchases with distinct descriptions both import', () => {
  const { db, accountId } = setup();
  const rows = [
    { date: '2026-03-01', payee: 'Coffee Bar', description: 'AUTH 8891', amountMinor: -450 },
    { date: '2026-03-01', payee: 'Coffee Bar', description: 'AUTH 8892', amountMinor: -450 },
  ];
  const plan = planImport(db, accountId, rows);
  assert.equal(plan.inserts.length, 2);
  assert.deepEqual(plan.skipped, []);
});

test('planImport: re-import overlapping range skips existing', () => {
  const { db, accountId } = setup();
  insertTxn(db, accountId, { date: '2026-03-01', payee: 'Coffee Bar', description: 'AUTH 8891', amountMinor: -450 });
  insertTxn(db, accountId, { date: '2026-03-01', payee: 'Coffee Bar', description: 'AUTH 8892', amountMinor: -450 });

  // M=1 of a row already present -> skip it
  const p1 = planImport(db, accountId, [
    { date: '2026-03-01', payee: 'Coffee Bar', description: 'AUTH 8891', amountMinor: -450 },
  ]);
  assert.equal(p1.inserts.length, 0);
  assert.equal(p1.skipped.length, 1);
  assert.equal(p1.skipped[0].rowIndex, 0);
  assert.equal(p1.skipped[0].reason, 'duplicate');
  assert.match(p1.skipped[0].fingerprint, /^[0-9a-f]{64}$/);

  // M=2 covering both existing rows -> skip both, import nothing
  const p2 = planImport(db, accountId, [
    { date: '2026-03-01', payee: 'Coffee Bar', description: 'AUTH 8891', amountMinor: -450 },
    { date: '2026-03-01', payee: 'COFFEE BAR', description: 'auth 8892', amountMinor: -450 },
  ]);
  assert.equal(p2.inserts.length, 0);
  assert.deepEqual(p2.skipped.map((s) => s.rowIndex), [0, 1]);
});

test('planImport: K < M inserts last M-K occurrences in stable order', () => {
  const { db, accountId } = setup();
  insertTxn(db, accountId, { date: '2026-03-01', payee: 'Coffee Bar', amountMinor: -450 });
  const rows = [
    { date: '2026-03-01', payee: 'Coffee Bar', amountMinor: -450 },
    { date: '2026-03-05', payee: 'Book Shop', amountMinor: -1200, description: 'vol 1' },
    { date: '2026-03-06', payee: 'Book Shop', amountMinor: -1200, description: 'vol 2' },
  ];
  const plan = planImport(db, accountId, rows);
  assert.deepEqual(plan.skipped.map((s) => s.rowIndex), [0]);
  const stripFp = ({ fingerprint, ...rest }) => rest;
  assert.deepEqual(plan.inserts.map(stripFp), [rows[1], rows[2]]);
});

test('planImport: mixed groups with distinct and duplicate fingerprints in one call', () => {
  const { db, accountId } = setup();
  insertTxn(db, accountId, { date: '2026-04-02', payee: 'Gas Station', amountMinor: -5000 });
  const rows = [
    { date: '2026-04-01', payee: 'Grocer A', amountMinor: -3000 },        // new -> insert
    { date: '2026-04-02', payee: 'pos Gas Station', amountMinor: -5000 }, // dup -> skip
    { date: '2026-04-03', payee: 'Cafe B', amountMinor: -800 },           // new -> insert
    { date: '2026-04-03', payee: 'Cafe B', amountMinor: -900 },           // diff amount -> insert
    { date: '2026-04-02', payee: 'GAS STATION!!', amountMinor: -5000 },   // 2nd occ, M=2 K=1 -> keep last
    { date: '2026-04-01', payee: 'Grocer A', description: 'ref 7', amountMinor: -3000 }, // distinct desc -> insert
  ];
  const plan = planImport(db, accountId, rows);
  const stripFp = ({ fingerprint, ...rest }) => rest;
  assert.deepEqual(plan.inserts.map(stripFp), [rows[0], rows[2], rows[3], rows[4], rows[5]]);
  assert.deepEqual(plan.skipped.map((s) => s.rowIndex), [1]);
  for (const s of plan.skipped) {
    assert.equal(s.reason, 'duplicate');
    assert.match(s.fingerprint, /^[0-9a-f]{64}(#\d+)?$/);
  }
});

test('planImport: skips are per-account', () => {
  const { db, accountId } = setup();
  const other = db
    .prepare(`INSERT INTO accounts (name, type) VALUES ('Other', 'credit')`)
    .run();
  const otherId = Number(other.lastInsertRowid);
  insertTxn(db, otherId, { date: '2026-05-01', payee: 'Same Store', amountMinor: -700 });
  const plan = planImport(db, accountId, [
    { date: '2026-05-01', payee: 'Same Store', amountMinor: -700 },
  ]);
  assert.equal(plan.inserts.length, 1);
  assert.equal(plan.skipped.length, 0);
});

test('planImport performs no writes', () => {
  const { db, accountId } = setup();
  insertTxn(db, accountId, { date: '2026-06-01', payee: 'Preexisting', amountMinor: -111 });
  const before = txnCount(db, accountId);
  planImport(db, accountId, [
    { date: '2026-06-01', payee: 'Preexisting', amountMinor: -111 },
    { date: '2026-06-02', payee: 'Brand New', amountMinor: -222 },
  ]);
  assert.equal(txnCount(db, accountId), before);
});
