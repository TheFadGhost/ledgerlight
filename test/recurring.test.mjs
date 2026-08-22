import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import { detectRecurring } from '../src/analytics/recurring.js';

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

test('detectRecurring: flags drifting monthly subscription across payee variants, skips stale rows', () => {
  const { db, accountId, cats } = setup();
  const subs = cat(cats, 'Subscriptions');
  txn(db, accountId, { date: '2025-10-15', payee: 'Netflix.com legacy', amountMinor: -1199, categoryId: subs });
  txn(db, accountId, { date: '2026-01-28', payee: 'Netflix.com 40812', amountMinor: -1199, categoryId: subs });
  txn(db, accountId, { date: '2026-02-27', payee: 'NETFLIX.COM 40812', amountMinor: -1199, categoryId: subs });
  txn(db, accountId, { date: '2026-03-29', payee: 'netflix.com 77', amountMinor: -1299, categoryId: subs });
  txn(db, accountId, { date: '2026-04-28', payee: 'Netflix.com 40812', amountMinor: -1299, categoryId: subs });
  txn(db, accountId, { date: '2026-05-28', payee: 'NETFLIX.COM 40812', amountMinor: -1299, categoryId: subs });

  const out = detectRecurring(db);
  const nf = out.find((r) => r.merchantKey === 'netflix.com');
  assert.ok(nf, 'expected netflix.com cluster to be detected');
  assert.equal(nf.cadence, 'monthly');
  assert.equal(nf.occurrences, 5);
  assert.equal(nf.firstDate, '2026-01-28');
  assert.equal(nf.lastDate, '2026-05-28');
  assert.equal(nf.nextExpectedDate, '2026-06-28');
  assert.equal(nf.medianAmountMinor, 1299);
  assert.equal(nf.minAmountMinor, 1199);
  assert.equal(nf.maxAmountMinor, 1299);
  assert.equal(nf.stabilityPct, 97);
  assert.equal(nf.confidence, 'high');
  assert.equal(nf.payeeDisplay, 'Netflix.com 40812');
});

test('detectRecurring: weekly gym charge detected with day-based next expected date', () => {
  const { db, accountId, cats } = setup();
  const ent = cat(cats, 'Entertainment');
  for (const day of ['2026-04-03', '2026-04-10', '2026-04-17', '2026-04-24', '2026-05-01', '2026-05-08']) {
    txn(db, accountId, { date: day, payee: 'Iron Gym Downtown', amountMinor: -1500, categoryId: ent });
  }
  const out = detectRecurring(db);
  const gym = out.find((r) => r.merchantKey === 'iron gym downtown');
  assert.ok(gym);
  assert.equal(gym.cadence, 'weekly');
  assert.equal(gym.occurrences, 6);
  assert.equal(gym.medianAmountMinor, 1500);
  assert.equal(gym.stabilityPct, 100);
  assert.equal(gym.confidence, 'high');
  assert.equal(gym.nextExpectedDate, '2026-05-15');
});

test('detectRecurring: medium confidence when occurrences gate blocks high', () => {
  const { db, accountId, cats } = setup();
  const shop = cat(cats, 'Shopping');
  for (const [day, amt] of [['2026-03-06', 2000], ['2026-03-20', 2000], ['2026-04-03', 2200], ['2026-04-17', 2000]]) {
    txn(db, accountId, { date: day, payee: 'CleanFit Laundry', amountMinor: -amt, categoryId: shop });
  }
  const out = detectRecurring(db);
  const cf = out.find((r) => r.merchantKey === 'cleanfit laundry');
  assert.ok(cf);
  assert.equal(cf.cadence, 'fortnightly');
  assert.equal(cf.occurrences, 4);
  assert.equal(cf.medianAmountMinor, 2000);
  assert.equal(cf.stabilityPct, 98);
  assert.equal(cf.confidence, 'medium');
});

test('detectRecurring: low-confidence 3-run still included', () => {
  const { db, accountId, cats } = setup();
  const sub = cat(cats, 'Subscriptions');
  for (const day of ['2026-05-04', '2026-05-11', '2026-05-18']) {
    txn(db, accountId, { date: day, payee: 'PaperTrail News', amountMinor: -999, categoryId: sub });
  }
  const out = detectRecurring(db);
  const pt = out.find((r) => r.merchantKey === 'papertrail news');
  assert.ok(pt);
  assert.equal(pt.occurrences, 3);
  assert.equal(pt.confidence, 'low');
});

test('detectRecurring: rejects irregular grocery noise and excludes transfers and short clusters', () => {
  const { db, accountId, cats } = setup();
  const groceries = cat(cats, 'Groceries');
  const noise = [
    ['2026-01-05', 4500], ['2026-01-15', 1280], ['2026-02-02', 6740], ['2026-02-21', 990],
    ['2026-03-03', 5200], ['2026-03-21', 1830], ['2026-04-08', 7420], ['2026-05-19', 2610],
  ];
  const payeeCycle = ['Wegmans', 'WEGMANS 88', 'wegmans'];
  noise.forEach(([day, amt], i) => {
    txn(db, accountId, {
      date: day,
      payee: payeeCycle[i % payeeCycle.length],
      amountMinor: -amt,
      categoryId: groceries,
    });
  });

  const transfers = cat(cats, 'Transfers');
  for (const day of ['2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01']) {
    txn(db, accountId, { date: day, payee: 'ACME RENT TRANSFER', amountMinor: -200000, categoryId: transfers });
  }

  const subs = cat(cats, 'Subscriptions');
  txn(db, accountId, { date: '2026-04-10', payee: 'Spotify Premium', amountMinor: -1499, categoryId: subs });
  txn(db, accountId, { date: '2026-05-10', payee: 'Spotify Premium', amountMinor: -1499, categoryId: subs });

  const out = detectRecurring(db);
  assert.equal(out.find((r) => r.merchantKey.includes('wegmans')), undefined);
  assert.equal(out.find((r) => r.merchantKey.includes('acme rent')), undefined);
  assert.equal(out.find((r) => r.merchantKey.includes('spotify')), undefined);
});

test('detectRecurring: empty database returns empty array; validates lookbackDays', () => {
  const { db } = setup();
  assert.deepEqual(detectRecurring(db), []);
  assert.throws(() => detectRecurring(db, { lookbackDays: 0 }), TypeError);
  assert.throws(() => detectRecurring(db, { lookbackDays: 1.5 }), TypeError);
});
