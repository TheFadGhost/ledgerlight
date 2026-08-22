import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import { budgetStatus, setBudget, uncategorizedInMonth } from '../src/analytics/budgets.js';

let fpSeq = 0;

function setup() {
  const db = openDb(':memory:');
  const cats = seedTaxonomy(db);
  const res = db
    .prepare(`INSERT INTO accounts (name, type, currency) VALUES ('Main', 'checking', 'USD')`)
    .run();
  return { db, accountId: Number(res.lastInsertRowid), cats };
}

function txn(db, accountId, { date, payee, amountMinor, categoryId = null }) {
  fpSeq += 1;
  db.prepare(
    `INSERT INTO transactions (account_id, date, payee, amount_minor, category_id, category_source, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(accountId, date, payee, amountMinor, categoryId, categoryId === null ? null : 'manual', `fp-${fpSeq}`);
}

const cat = (cats, name) => {
  const id = cats.get(name);
  if (id == null) throw new Error(`missing category ${name}`);
  return id;
};

test('budgetStatus: near/under/over boundaries at exactly 80%, 79%, 100% and 101%', () => {
  const { db, accountId, cats } = setup();
  const groceries = cat(cats, 'Groceries');
  setBudget(db, groceries, 10000);
  txn(db, accountId, { date: '2026-01-05', payee: 'Kroger', amountMinor: -8000, categoryId: groceries });
  txn(db, accountId, { date: '2026-02-05', payee: 'Kroger', amountMinor: -7900, categoryId: groceries });
  txn(db, accountId, { date: '2026-03-05', payee: 'Kroger', amountMinor: -10100, categoryId: groceries });
  txn(db, accountId, { date: '2026-04-05', payee: 'Kroger', amountMinor: -10000, categoryId: groceries });

  const jan = budgetStatus(db, '2026-01');
  assert.equal(jan.length, 1);
  assert.equal(jan[0].pctUsedBps, 8000);
  assert.equal(jan[0].state, 'near');

  const feb = budgetStatus(db, '2026-02');
  assert.equal(feb[0].pctUsedBps, 7900);
  assert.equal(feb[0].state, 'under');

  const mar = budgetStatus(db, '2026-03');
  assert.equal(mar[0].pctUsedBps, 10100);
  assert.equal(mar[0].state, 'over');

  const apr = budgetStatus(db, '2026-04');
  assert.equal(apr[0].pctUsedBps, 10000);
  assert.equal(apr[0].state, 'near', 'exactly 10000 bps is near, over requires strictly more');

  for (const row of [...jan, ...feb, ...mar, ...apr]) {
    assert.equal(row.remainingMinor, row.monthlyAmountMinor + row.spentMinor);
    assert.equal(row.spentMinor < 0, true);
    assert.equal(row.categoryName, 'Groceries');
    assert.equal(row.parentName, 'Food & Dining');
  }
});

test('budgetStatus: sorted by pctUsedBps desc with parent names and remaining math', () => {
  const { db, accountId, cats } = setup();
  const groceries = cat(cats, 'Groceries');
  const restaurants = cat(cats, 'Restaurants & Cafes');
  const transit = cat(cats, 'Transit & Fuel');
  const health = cat(cats, 'Health & Pharmacy');
  setBudget(db, groceries, 10000);
  setBudget(db, restaurants, 5000);
  setBudget(db, transit, 4000);
  setBudget(db, health, 8000);

  txn(db, accountId, { date: '2026-06-02', payee: 'Kroger', amountMinor: -9500, categoryId: groceries });
  txn(db, accountId, { date: '2026-06-03', payee: 'Cafe', amountMinor: -2500, categoryId: restaurants });
  txn(db, accountId, { date: '2026-06-04', payee: 'Metro', amountMinor: -4000, categoryId: transit });

  const rows = budgetStatus(db, '2026-06');
  assert.deepEqual(rows.map((r) => r.categoryName), ['Transit & Fuel', 'Groceries', 'Restaurants & Cafes', 'Health & Pharmacy']);
  assert.deepEqual(rows.map((r) => r.pctUsedBps), [10000, 9500, 5000, 0]);
  assert.deepEqual(rows.map((r) => r.parentName), ['Transport', 'Food & Dining', 'Food & Dining', 'Personal & Health']);
  assert.deepEqual(rows.map((r) => r.remainingMinor), [0, 500, 2500, 8000]);
  assert.deepEqual(rows.map((r) => r.state), ['near', 'near', 'under', 'under']);
});

test('budgetStatus: February leap-year and non-leap month boundaries via string comparison', () => {
  const { db, accountId, cats } = setup();
  const groceries = cat(cats, 'Groceries');
  setBudget(db, groceries, 10000);
  txn(db, accountId, { date: '2024-02-29', payee: 'Leap Day Shop', amountMinor: -6100, categoryId: groceries });
  txn(db, accountId, { date: '2026-02-28', payee: 'Feb End Shop', amountMinor: -9000, categoryId: groceries });
  txn(db, accountId, { date: '2026-03-01', payee: 'March Spillover', amountMinor: -500, categoryId: groceries });

  const leap = budgetStatus(db, '2024-02');
  assert.equal(leap[0].spentMinor, -6100);
  assert.equal(leap[0].state, 'under');

  const febNonLeap = budgetStatus(db, '2026-02');
  assert.equal(febNonLeap[0].spentMinor, -9000);
  assert.equal(febNonLeap[0].state, 'near');

  const march = budgetStatus(db, '2026-03');
  assert.equal(march[0].spentMinor, -500);
  assert.equal(march[0].state, 'under');
});

test('setBudget: rejects non-positive/non-integer amounts and upserts single row', () => {
  const { db, cats } = setup();
  const groceries = cat(cats, 'Groceries');
  for (const bad of [0, -5, 1.5, 'x', NaN, null]) {
    assert.throws(() => setBudget(db, groceries, bad), TypeError);
  }

  const firstId = setBudget(db, groceries, 12000);
  let rows = db.prepare('SELECT id, monthly_amount_minor FROM budgets').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, firstId);
  assert.equal(rows[0].monthly_amount_minor, 12000);

  const secondId = setBudget(db, groceries, 20000);
  rows = db.prepare('SELECT id, monthly_amount_minor FROM budgets').all();
  assert.equal(rows.length, 1, 'upsert must not duplicate');
  assert.equal(secondId, firstId);
  assert.equal(rows[0].monthly_amount_minor, 20000);

  const status = budgetStatus(db, '2026-01');
  assert.equal(status[0].monthlyAmountMinor, 20000);
});

test('uncategorizedInMonth: count and signed total scoped to the month', () => {
  const { db, accountId, cats } = setup();
  txn(db, accountId, { date: '2026-05-02', payee: 'Mystery A', amountMinor: -3000 });
  txn(db, accountId, { date: '2026-05-30', payee: 'Mystery B', amountMinor: -200 });
  txn(db, accountId, { date: '2026-05-11', payee: 'Refund', amountMinor: 1000 });
  txn(db, accountId, { date: '2026-05-04', payee: 'Kroger', amountMinor: -4000, categoryId: cat(cats, 'Groceries') });
  txn(db, accountId, { date: '2026-04-09', payee: 'Old Mystery', amountMinor: -999 });

  assert.deepEqual(uncategorizedInMonth(db, '2026-05'), { count: 3, totalMinor: -2200 });
  assert.deepEqual(uncategorizedInMonth(db, '2026-04'), { count: 1, totalMinor: -999 });
  assert.deepEqual(uncategorizedInMonth(db, '2026-06'), { count: 0, totalMinor: 0 });
});
