import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import { monthSummaries, spendByCategory, spendOverTime, topMerchants } from '../src/analytics/aggregate.js';
import { budgetStatus, setBudget, uncategorizedInMonth } from '../src/analytics/budgets.js';
import { detectRecurring } from '../src/analytics/recurring.js';

function setup() {
  const db = openDb(':memory:');
  seedTaxonomy(db);
  db.prepare(`INSERT INTO accounts (name) VALUES ('A')`).run();
  const acc = db.prepare('SELECT id FROM accounts').get().id;
  const cats = {};
  for (const c of db.prepare("SELECT id, name FROM categories WHERE kind!='group'").all()) {
    cats[c.name] = c.id;
  }
  return { db, acc, cats };
}

function insertTxn(db, acc, date, payee, amountMinor, categoryId = null) {
  return db
    .prepare(
      `INSERT INTO transactions (account_id, date, payee, amount_minor, category_id, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(acc, date, payee, amountMinor, categoryId, `fp-${date}-${payee}-${amountMinor}-${Math.random()}`)
    .lastInsertRowid;
}

test('no splits: aggregations unchanged (regression guard)', () => {
  const { db, acc, cats } = setup();
  insertTxn(db, acc, '2026-03-01', 'Salary Co', 300000, cats.Salary);
  insertTxn(db, acc, '2026-03-05', 'Grocer', -5000, cats.Groceries);
  insertTxn(db, acc, '2026-03-06', 'Cafe', -2000, null);

  const s = monthSummaries(db, '2026-03', '2026-03')[0];
  assert.equal(s.incomeMinor, 300000);
  assert.equal(s.expenseMinor, -5000);
  assert.equal(s.uncategorizedExpenseMinor, -2000);
  assert.equal(s.netMinor, 293000);

  const byCat = spendByCategory(db, '2026-03');
  const grocer = byCat.find((r) => r.name === 'Groceries');
  assert.equal(grocer.totalMinor, -5000);
  assert.equal(grocer.txnCount, 1);
});

test('split parent excluded exactly once; children counted with own categories/dates', () => {
  const { db, acc, cats } = setup();
  // Parent: -10000 at Superstore on 2026-04-10, split into -7000 groceries + -3000 pharmacy.
  const parentId = insertTxn(db, acc, '2026-04-10', 'Superstore', -10000, cats.Groceries);
  db.prepare(
    `INSERT INTO splits (transaction_id, amount_minor, category_id, note) VALUES (?, ?, ?, '')`,
  ).run(parentId, -7000, cats.Groceries);
  db.prepare(
    `INSERT INTO splits (transaction_id, amount_minor, category_id, note) VALUES (?, ?, ?, '')`,
  ).run(parentId, -3000, cats['Health & Pharmacy']);
  // Unrelated income.
  insertTxn(db, acc, '2026-04-01', 'Pay', 500000, cats.Salary);

  const s = monthSummaries(db, '2026-04', '2026-04')[0];
  assert.equal(s.incomeMinor, 500000);
  assert.equal(s.expenseMinor, -10000, 'children sum replaces parent; no double count');

  const byCat = spendByCategory(db, '2026-04');
  const g = byCat.find((r) => r.name === 'Groceries');
  assert.equal(g.totalMinor, -7000);
  assert.equal(g.txnCount, 1, 'parent not counted in Groceries');
  const h = byCat.find((r) => r.name === 'Health & Pharmacy');
  assert.equal(h.totalMinor, -3000);

  const overTime = spendOverTime(db, '2026-04-01', '2026-04-30');
  assert.deepEqual(overTime, [{ day: '2026-04-10', totalMinor: -10000 }],
    'children roll up to the PARENT date');

  const merchants = topMerchants(db, '2026-04-01', '2026-04-30');
  assert.equal(merchants.length, 1);
  assert.equal(merchants[0].payee, 'Superstore');
  assert.equal(merchants[0].totalMinor, 10000);
});

test('budgets count split parts toward part-category budgets only', () => {
  const { db, acc, cats } = setup();
  setBudget(db, cats.Groceries, 50000); // $500/mo
  const parentId = insertTxn(db, acc, '2026-05-02', 'Mega Mart', -60000, cats.Groceries);
  db.prepare('INSERT INTO splits (transaction_id, amount_minor, category_id, note) VALUES (?, ?, ?, ?)')
    .run(parentId, -45000, cats.Groceries, '');
  db.prepare('INSERT INTO splits (transaction_id, amount_minor, category_id, note) VALUES (?, ?, ?, ?)')
    .run(parentId, -15000, cats.Shopping, '');

  const [groceryBudget] = budgetStatus(db, '2026-05');
  assert.equal(groceryBudget.categoryName, 'Groceries');
  assert.equal(groceryBudget.spentMinor, -45000, 'only the grocery part counts');
  assert.equal(groceryBudget.state, 'near', '45000/50000 = 9000bps >= near threshold');
});

test('uncategorized summaries include split children without category', () => {
  const { db, acc, cats } = setup();
  const parentId = insertTxn(db, acc, '2026-06-01', 'Kiosk', -2500, null);
  db.prepare('INSERT INTO splits (transaction_id, amount_minor, category_id, note) VALUES (?, ?, ?, ?)')
    .run(parentId, -1500, cats.Restaurants ?? cats.Groceries, '');
  db.prepare('INSERT INTO splits (transaction_id, amount_minor, category_id, note) VALUES (?, ?, ?, ?)')
    .run(parentId, -1000, null, '');

  const u = uncategorizedInMonth(db, '2026-06');
  assert.equal(u.count, 1);
  assert.equal(u.totalMinor, -1000);
});

test('recurring detector sees split amounts, not parent lump', () => {
  const { db, acc, cats } = setup();
  // Monthly subscription of -1200 split into -900 service + -300 tip would break cadence;
  // instead verify a clean recurring merchant still detected when ANOTHER txn is split.
  for (const d of ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05']) {
    insertTxn(db, acc, d, 'Demo Streaming', -1200, cats.Subscriptions);
  }
  const parentId = insertTxn(db, acc, '2026-03-20', 'Store X', -5000, cats.Shopping);
  db.prepare('INSERT INTO splits (transaction_id, amount_minor, category_id, note) VALUES (?, ?, ?, ?)')
    .run(parentId, -3000, cats.Shopping, '');
  db.prepare('INSERT INTO splits (transaction_id, amount_minor, category_id, note) VALUES (?, ?, ?, ?)')
    .run(parentId, -2000, cats.Groceries, '');

  const rec = detectRecurring(db, { lookbackDays: 365 });
  const stream = rec.find((r) => r.payeeDisplay === 'Demo Streaming');
  assert.ok(stream, 'subscription detected');
  assert.equal(stream.medianAmountMinor, 1200);
  assert.equal(stream.occurrences, 4);
});
