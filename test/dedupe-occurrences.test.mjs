import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import { planImport } from '../src/dedupe.js';

function setup() {
  const db = openDb(':memory:');
  seedTaxonomy(db);
  db.prepare(
    `INSERT INTO accounts (name, type) VALUES ('Test Checking', 'checking')`,
  ).run();
  const accountId = db.prepare(`SELECT id FROM accounts LIMIT 1`).get().id;
  return { db, accountId };
}

function insertTxn(db, accountId, row) {
  db.prepare(
    `INSERT INTO transactions (account_id, date, payee, description, amount_minor, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(accountId, row.date, row.payee, row.description ?? '', row.amountMinor, row.fingerprint);
}

function countAll(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get().n;
}

const identicalPurchase = {
  date: '2026-03-10',
  payee: 'Coffee Corner',
  description: 'Card purchase',
  amountMinor: -450,
};

test('two genuinely identical same-day purchases coexist on fresh import', () => {
  const { db, accountId } = setup();
  const { inserts, skipped } = planImport(db, accountId, [
    { ...identicalPurchase },
    { ...identicalPurchase },
  ]);
  assert.equal(inserts.length, 2);
  assert.equal(skipped.length, 0);
  const fps = new Set(inserts.map((r) => r.fingerprint));
  assert.equal(fps.size, 2, 'occurrence-qualified fingerprints differ');

  for (const r of inserts) insertTxn(db, accountId, r);
  assert.equal(countAll(db), 2);
});

test('re-import of overlapping range never double-counts', () => {
  const { db, accountId } = setup();
  let { inserts } = planImport(db, accountId, [{ ...identicalPurchase }, { ...identicalPurchase }]);
  for (const r of inserts) insertTxn(db, accountId, r);

  // Full overlap: same two rows again.
  ({ inserts } = planImport(db, accountId, [{ ...identicalPurchase }, { ...identicalPurchase }]));
  assert.equal(inserts.length, 0);
  assert.equal(countAll(db), 2);

  // Partial overlap: only one of them appears in a shorter export.
  const partial = planImport(db, accountId, [{ ...identicalPurchase }]);
  assert.equal(partial.inserts.length, 0);
  assert.equal(partial.skipped.length, 1);
  assert.equal(partial.skipped[0].reason, 'duplicate');
  assert.equal(countAll(db), 2);
});

test('a third real occurrence is added on re-import after growth', () => {
  const { db, accountId } = setup();
  let res = planImport(db, accountId, [{ ...identicalPurchase }]);
  for (const r of res.inserts) insertTxn(db, accountId, r);

  // Later export contains two purchases; one already known.
  res = planImport(db, accountId, [{ ...identicalPurchase }, { ...identicalPurchase }]);
  assert.equal(res.inserts.length, 1);
  assert.equal(res.skipped.length, 1);
  for (const r of res.inserts) insertTxn(db, accountId, r);
  assert.equal(countAll(db), 2);
});

test('near-duplicates that differ stay distinct', () => {
  const { db, accountId } = setup();
  const rows = [
    { ...identicalPurchase },
    { ...identicalPurchase, amountMinor: -455 },
    { ...identicalPurchase, date: '2026-03-11' },
    { ...identicalPurchase, payee: 'Coffee House' },
  ];
  const { inserts, skipped } = planImport(db, accountId, rows);
  assert.equal(inserts.length, 4);
  assert.equal(skipped.length, 0);
  const fps = new Set(inserts.map((r) => r.fingerprint));
  assert.equal(fps.size, 4);
});

test('skips are scoped per account', () => {
  const { db, accountId } = setup();
  db.prepare(`INSERT INTO accounts (name, type) VALUES ('Other', 'checking')`).run();
  const otherId = db
    .prepare(`SELECT id FROM accounts WHERE name='Other'`)
    .get().id;

  let res = planImport(db, accountId, [{ ...identicalPurchase }]);
  for (const r of res.inserts) insertTxn(db, accountId, r);

  res = planImport(db, otherId, [{ ...identicalPurchase }]);
  assert.equal(res.inserts.length, 1, 'same rows under another account are new');
});
