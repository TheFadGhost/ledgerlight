import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import {
  monthSummaries,
  spendByCategory,
  spendOverTime,
  topMerchants,
  momChanges,
  uncategorizedSummary,
} from '../src/analytics/aggregate.js';

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

test('monthSummaries: sign conventions, transfer exclusion, uncategorized bucket, net reconciles', () => {
  const { db, accountId, cats } = setup();
  txn(db, accountId, { date: '2026-01-05', payee: 'Acme Payroll', amountMinor: 500000, categoryId: cat(cats, 'Salary') });
  txn(db, accountId, { date: '2026-01-09', payee: 'Kroger', amountMinor: -12000, categoryId: cat(cats, 'Groceries') });
  txn(db, accountId, { date: '2026-01-15', payee: 'Corner Cafe', amountMinor: -8000, categoryId: cat(cats, 'Restaurants & Cafes') });
  txn(db, accountId, { date: '2026-01-20', payee: 'CC Payment', amountMinor: -30000, categoryId: cat(cats, 'Transfers') });
  txn(db, accountId, { date: '2026-01-22', payee: 'Mystery Charge', amountMinor: -5000 });
  txn(db, accountId, { date: '2026-01-25', payee: 'Random Refund', amountMinor: 7000 });
  txn(db, accountId, { date: '2026-02-03', payee: 'Kroger', amountMinor: -100, categoryId: cat(cats, 'Groceries') });

  const rows = monthSummaries(db, '2026-01', '2026-03');
  assert.deepEqual(rows.map((r) => r.month), ['2026-01', '2026-02', '2026-03']);

  const jan = rows[0];
  assert.equal(jan.incomeMinor, 507000);
  assert.equal(jan.expenseMinor, -20000);
  assert.equal(jan.transfersMinor, -30000);
  assert.equal(jan.uncategorizedExpenseMinor, -5000);
  assert.equal(jan.netMinor, 452000);

  const feb = rows[1];
  assert.equal(feb.incomeMinor, 0);
  assert.equal(feb.expenseMinor, -100);
  assert.equal(feb.transfersMinor, 0);
  assert.equal(feb.uncategorizedExpenseMinor, 0);
  assert.equal(feb.netMinor, -100);

  assert.deepEqual(rows[2], {
    month: '2026-03',
    incomeMinor: 0,
    expenseMinor: 0,
    netMinor: 0,
    transfersMinor: 0,
    uncategorizedExpenseMinor: 0,
  });

  assert.deepEqual(monthSummaries(db, '2026-02', '2026-02'), [feb]);
});

test('monthSummaries: rejects bad month keys and reversed ranges', () => {
  const { db } = setup();
  assert.throws(() => monthSummaries(db, '2026-1', '2026-03'), TypeError);
  assert.throws(() => monthSummaries(db, 202601, '2026-03'), TypeError);
  assert.throws(() => monthSummaries(db, '2026-02', '2026-01'), RangeError);
});

test('spendByCategory: ordering by magnitude, parentName, Uncategorized entry, transfers excluded, limit', () => {
  const { db, accountId, cats } = setup();
  txn(db, accountId, { date: '2026-01-02', payee: 'Kroger A', amountMinor: -5000, categoryId: cat(cats, 'Groceries') });
  txn(db, accountId, { date: '2026-01-03', payee: 'Kroger B', amountMinor: -4000, categoryId: cat(cats, 'Groceries') });
  txn(db, accountId, { date: '2026-01-05', payee: 'Corner Cafe', amountMinor: -7000, categoryId: cat(cats, 'Restaurants & Cafes') });
  txn(db, accountId, { date: '2026-01-06', payee: 'Mystery', amountMinor: -3000 });
  txn(db, accountId, { date: '2026-01-07', payee: 'CC Payment', amountMinor: -50000, categoryId: cat(cats, 'Transfers') });
  txn(db, accountId, { date: '2026-01-08', payee: 'Payroll', amountMinor: 9999, categoryId: cat(cats, 'Salary') });

  const rows = spendByCategory(db, '2026-01');
  assert.deepEqual(
    rows.map((r) => [r.name, r.totalMinor]),
    [['Groceries', -9000], ['Restaurants & Cafes', -7000], ['Uncategorized', -3000]],
  );
  assert.equal(rows[0].categoryId, cat(cats, 'Groceries'));
  assert.equal(rows[0].parentName, 'Food & Dining');
  assert.equal(rows[0].txnCount, 2);
  assert.equal(rows[1].parentName, 'Food & Dining');
  assert.equal(rows[1].txnCount, 1);
  assert.equal(rows[2].categoryId, null);
  assert.equal(rows[2].parentName, null);

  const limited = spendByCategory(db, '2026-01', { limit: 2 });
  assert.deepEqual(limited.map((r) => r.name), ['Groceries', 'Restaurants & Cafes']);
});

test('spendOverTime: daily negative totals, zero-spend days omitted, transfers excluded', () => {
  const { db, accountId, cats } = setup();
  txn(db, accountId, { date: '2026-01-02', payee: 'Kroger', amountMinor: -5000, categoryId: cat(cats, 'Groceries') });
  txn(db, accountId, { date: '2026-01-02', payee: 'Payroll', amountMinor: 2000, categoryId: cat(cats, 'Salary') });
  txn(db, accountId, { date: '2026-01-05', payee: 'Cafe', amountMinor: -1200, categoryId: cat(cats, 'Restaurants & Cafes') });
  txn(db, accountId, { date: '2026-01-06', payee: 'CC Payment', amountMinor: -900, categoryId: cat(cats, 'Transfers') });
  txn(db, accountId, { date: '2026-01-07', payee: 'Refund', amountMinor: 500 });
  txn(db, accountId, { date: '2026-01-08', payee: 'Mystery', amountMinor: -300 });

  assert.deepEqual(spendOverTime(db, '2026-01-01', '2026-01-10'), [
    { day: '2026-01-02', totalMinor: -5000 },
    { day: '2026-01-05', totalMinor: -1200 },
    { day: '2026-01-08', totalMinor: -300 },
  ]);
});

test('topMerchants: exact-payee grouping, positive magnitudes, counts, limit', () => {
  const { db, accountId, cats } = setup();
  txn(db, accountId, { date: '2026-01-02', payee: 'Kroger #112', amountMinor: -5000, categoryId: cat(cats, 'Groceries') });
  txn(db, accountId, { date: '2026-01-04', payee: 'Kroger #112', amountMinor: -2500, categoryId: cat(cats, 'Groceries') });
  txn(db, accountId, { date: '2026-01-05', payee: 'KROGER #112', amountMinor: -6500, categoryId: cat(cats, 'Groceries') });
  txn(db, accountId, { date: '2026-01-06', payee: 'Blue Bottle', amountMinor: -3000, categoryId: cat(cats, 'Restaurants & Cafes') });
  txn(db, accountId, { date: '2026-01-07', payee: 'Blue Bottle', amountMinor: -3000, categoryId: cat(cats, 'Restaurants & Cafes') });
  txn(db, accountId, { date: '2026-01-08', payee: 'Card Pmt', amountMinor: -99000, categoryId: cat(cats, 'Transfers') });

  const rows = topMerchants(db, '2026-01-01', '2026-01-31');
  assert.deepEqual(
    rows.map((r) => [r.payee, r.totalMinor, r.txnCount]),
    [['Kroger #112', 7500, 2], ['KROGER #112', 6500, 1], ['Blue Bottle', 6000, 2]],
  );

  const limited = topMerchants(db, '2026-01-01', '2026-01-31', { limit: 2 });
  assert.deepEqual(limited.map((r) => r.payee), ['Kroger #112', 'KROGER #112']);
});

test('momChanges: totals vs previous calendar month and per-category deltas', () => {
  const { db, accountId, cats } = setup();
  txn(db, accountId, { date: '2026-01-06', payee: 'Payroll', amountMinor: 90000, categoryId: cat(cats, 'Salary') });
  txn(db, accountId, { date: '2026-01-08', payee: 'Kroger', amountMinor: -40000, categoryId: cat(cats, 'Groceries') });
  txn(db, accountId, { date: '2026-01-15', payee: 'Cafe', amountMinor: -10000, categoryId: cat(cats, 'Restaurants & Cafes') });
  txn(db, accountId, { date: '2026-01-20', payee: 'CC Payment', amountMinor: -1000, categoryId: cat(cats, 'Transfers') });
  txn(db, accountId, { date: '2026-02-06', payee: 'Payroll', amountMinor: 100000, categoryId: cat(cats, 'Salary') });
  txn(db, accountId, { date: '2026-02-08', payee: 'Kroger', amountMinor: -50000, categoryId: cat(cats, 'Groceries') });
  txn(db, accountId, { date: '2026-02-12', payee: 'Cinema', amountMinor: -8000, categoryId: cat(cats, 'Entertainment') });
  txn(db, accountId, { date: '2026-02-20', payee: 'CC Payment', amountMinor: -2000, categoryId: cat(cats, 'Transfers') });

  const res = momChanges(db, '2026-02');
  assert.deepEqual(res.totals, {
    incomeMinor: 100000,
    expenseMinor: -58000,
    netMinor: 40000,
    prevIncomeMinor: 90000,
    prevExpenseMinor: -50000,
    prevNetMinor: 39000,
  });

  const groceries = res.categories.find((c) => c.name === 'Groceries');
  assert.deepEqual(groceries, {
    categoryId: cat(cats, 'Groceries'),
    name: 'Groceries',
    currentMinor: -50000,
    previousMinor: -40000,
    deltaMinor: -10000,
    deltaBps: -2500,
  });

  const restaurants = res.categories.find((c) => c.name === 'Restaurants & Cafes');
  assert.equal(restaurants.currentMinor, 0);
  assert.equal(restaurants.previousMinor, -10000);
  assert.equal(restaurants.deltaMinor, 10000);
  assert.equal(restaurants.deltaBps, 10000);

  const entertainment = res.categories.find((c) => c.name === 'Entertainment');
  assert.equal(entertainment.previousMinor, 0);
  assert.equal(entertainment.deltaBps, null, 'previous zero must yield null deltaBps');
});

test('uncategorizedSummary: count and signed total across all uncategorized transactions', () => {
  const { db, accountId, cats } = setup();
  txn(db, accountId, { date: '2026-01-02', payee: 'Mystery A', amountMinor: -3000 });
  txn(db, accountId, { date: '2026-02-09', payee: 'Mystery B', amountMinor: -700 });
  txn(db, accountId, { date: '2026-02-10', payee: 'Kroger', amountMinor: -100, categoryId: cat(cats, 'Groceries') });
  assert.deepEqual(uncategorizedSummary(db), { count: 2, totalMinor: -3700 });
});
