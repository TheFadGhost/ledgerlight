// Seeds a demo database with SYNTHETIC data by driving the real import
// pipeline over the committed fixtures. Obviously fake merchants throughout.
// Usage: node scripts/seed-demo.mjs [--db path]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbArg = process.argv.indexOf('--db');
const dbPath = dbArg >= 0 ? process.argv[dbArg + 1] : undefined;
if (dbPath) process.env.LEDGERLIGHT_DB = dbPath;

process.chdir(root);
const { openDb } = await import('../src/core/db.js');
const { seedTaxonomy } = await import('../src/core/seed.js');
const { commitImport } = await import('../src/import/importer.js');
const { setBudget } = await import('../src/analytics/budgets.js');

const db = openDb();
seedTaxonomy(db);

const catIdByName = new Map(
  db.prepare("SELECT id, name FROM categories WHERE kind != 'group'").all().map((c) => [c.name, c.id]),
);

// Demo rules beyond the seeded defaults.
const insRule = db.prepare(
  `INSERT INTO rules (priority, name, match_type, pattern, category_id, source) VALUES (?, ?, 'substring', ?, ?, 'user')`,
);
for (const [name, pattern, cat] of [
  ['Demo Streaming', 'demo streaming', 'Subscriptions'],
  ['Fake Gym membership', 'fake gym', 'Health & Pharmacy'],
  ['TEST Mart groceries', 'test mart', 'Groceries'],
]) {
  const exists = db.prepare('SELECT COUNT(*) AS n FROM rules WHERE name=?').get(name).n;
  if (!exists) insRule.run(20, name, pattern, catIdByName.get(cat));
}

const imports = [
  ['fixtures/01-quoted-commas.csv', 'Demo Checking', { dateFormat: 'mdy' }],
  ['fixtures/04-semicolon-decimal-comma.csv', 'Demo Savings', { dateFormat: 'dmy' }],
  ['fixtures/05-parentheses-negatives.csv', 'Demo Credit Card', {}],
];

let importedTotal = 0;
for (const [file, accountName, opts] of imports) {
  const content = readFileSync(join(root, file), 'utf8');
  const res = commitImport(db, Buffer.from(content, 'utf8'), {
    content,
    accountName,
    ...opts,
  });
  importedTotal += res.importedCount;
  console.log(`${file} -> ${accountName}: imported ${res.importedCount}, skipped ${res.skippedCount}, errors ${res.errorCount}`);
}

// A couple of demo budgets (leaf categories only).
setBudget(db, catIdByName.get('Groceries'), 40000);
setBudget(db, catIdByName.get('Restaurants & Cafes'), 15000);
setBudget(db, catIdByName.get('Transit & Fuel'), 25000);

const counts = {};
for (const t of ['accounts', 'transactions', 'rules', 'budgets']) {
  counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
}
console.log('Demo database seeded:', JSON.stringify(counts));
console.log(`DB at ${process.env.LEDGERLIGHT_DB}`);
