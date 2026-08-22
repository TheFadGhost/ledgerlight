import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openDb } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import {
  previewImport,
  commitImport,
  ImportError,
  importProgressChunks,
} from '../src/import/importer.js';

const require = createRequire(import.meta.url);
let engineAvailable = false;
try {
  require.resolve('../src/rules/engine.js');
  engineAvailable = true;
} catch {
  engineAvailable = false;
}

const buf = (s) => Buffer.from(s, 'utf8');
const bomBuf = (s) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf(s)]);

function setup() {
  const db = openDb(':memory:');
  seedTaxonomy(db);
  return db;
}

function counts(db) {
  return {
    accounts: db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,
    txns: db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,
    files: db.prepare('SELECT COUNT(*) AS n FROM import_files').get().n,
    profiles: db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n,
  };
}

const SIGNED_CSV = [
  'Date,Amount,Payee,Note',
  '25/12/2026,-42.50,Cafe Grumpy,flat white',
  '13/11/2026,"-1,234.00",Payroll Co,year bonus',
  '01/12/2026,-9.99,Streamflix,subscription',
].join('\n');

const SEMI_CSV = [
  'Datum;Betrag;Empfaenger;Verwendung',
  '17.02.2026;-12,50;REWE;einkauf',
  '18.02.2026;"1.234,56";Stadtwerke;strom',
].join('\n');

const DC_CSV = [
  'Date,Debit,Credit,Payee,Memo',
  '14/01/2027,10.00,,Kroger,groceries',
  '15/01/2027,,250.00,ACME Corp,refund',
  '16/01/2027,3.20,,Metro Transit,bus fare',
].join('\n');

test('ImportError carries code and meta', () => {
  const e = new ImportError('CODE_X', 'boom', { a: 1 });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'ImportError');
  assert.equal(e.code, 'CODE_X');
  assert.equal(e.message, 'boom');
  assert.deepEqual(e.meta, { a: 1 });
});

test('previewImport detects signed comma CSV end to end without writing', () => {
  const db = setup();
  const before = counts(db);
  const p = previewImport(db, buf(SIGNED_CSV));
  assert.deepEqual(counts(db), before);

  assert.equal(p.encoding, 'utf-8');
  assert.equal(p.delimiter, ',');
  assert.equal(p.headerRowIndex, 0);
  assert.deepEqual(p.headerLabels, ['Date', 'Amount', 'Payee', 'Note']);
  assert.equal(p.rowCount, 3);
  assert.equal(p.columnMapGuess.date, 0);
  assert.equal(p.columnMapGuess.amount, 1);
  assert.equal(p.columnMapGuess.payee, 2);
  assert.equal(p.columnMapGuess.description, 3);
  assert.deepEqual(p.dateFormatCandidates, ['dmy']);
  assert.equal(p.dateAmbiguous, false);
  assert.equal(p.amountFormatHint.decimalHint, 'dot');
  assert.deepEqual(p.accounts, []);
  assert.equal(p.errors.length, 0);
  assert.equal(p.sampleRows.length, 3);
  assert.deepEqual(p.sampleRows[0], {
    dateRaw: '25/12/2026',
    amountRaw: '-42.50',
    payee: 'Cafe Grumpy',
    description: 'flat white',
  });
});

test('previewImport lists existing account names sorted', () => {
  const db = setup();
  db.prepare("INSERT INTO accounts (name) VALUES ('Z Savings')").run();
  db.prepare("INSERT INTO accounts (name) VALUES ('A Checking')").run();
  const p = previewImport(db, buf(SIGNED_CSV));
  assert.deepEqual(p.accounts, ['A Checking', 'Z Savings']);
});

test('commitImport signed single amount CSV creates account, txns, ledger row', () => {
  const db = setup();
  const r = commitImport(db, buf(SIGNED_CSV), { accountName: 'Everyday', filename: 'dec.csv' });
  assert.equal(Number.isInteger(r.fileId), true);
  assert.equal(r.importedCount, 3);
  assert.equal(r.skippedCount, 0);
  assert.equal(r.errorCount, 0);
  assert.equal(r.rowCount, 3);
  assert.equal(r.profileSaved, null);

  const acc = db.prepare('SELECT id FROM accounts WHERE name = ?').get('Everyday');
  assert.ok(acc);
  const rows = db
    .prepare('SELECT date, amount_minor FROM transactions WHERE account_id = ? ORDER BY date')
    .all(acc.id);
  assert.deepEqual(
    rows.map((x) => x.date),
    ['2026-11-13', '2026-12-01', '2026-12-25'],
  );
  assert.equal(rows.find((x) => x.date === '2026-11-13').amount_minor, -123400);
  assert.equal(rows.find((x) => x.date === '2026-12-01').amount_minor, -999);
  assert.equal(rows.find((x) => x.date === '2026-12-25').amount_minor, -4250);

  const f = db
    .prepare('SELECT filename, row_count, imported_count, skipped_count, error_count FROM import_files')
    .get();
  assert.equal(f.filename, 'dec.csv');
  assert.equal(f.row_count, 3);
  assert.equal(f.imported_count, 3);
  assert.equal(f.skipped_count, 0);
  assert.equal(f.error_count, 0);

  const details = JSON.parse(db.prepare('SELECT details FROM import_files').get().details);
  assert.deepEqual(details.errors, []);
  assert.deepEqual(details.skipped, []);
});

test('semicolon CSV with decimal commas gets hint comma and exact minor units', () => {
  const db = setup();
  const p = previewImport(db, buf(SEMI_CSV));
  assert.equal(p.delimiter, ';');
  assert.equal(p.amountFormatHint.decimalHint, 'comma');
  assert.equal(p.dateAmbiguous, false);
  assert.equal(p.columnMapGuess.amount, 1);

  const r = commitImport(db, buf(SEMI_CSV), { accountName: 'DE Konto', dateFormat: 'dmy' });
  assert.equal(r.importedCount, 2);
  const rows = db
    .prepare('SELECT date, amount_minor FROM transactions ORDER BY date')
    .all()
    .map((x) => ({ ...x }));
  assert.deepEqual(rows, [
    { date: '2026-02-17', amount_minor: -1250 },
    { date: '2026-02-18', amount_minor: 123456 },
  ]);
});

test('separate Debit/Credit columns merge to negative debit / positive credit', () => {
  const db = setup();
  const r = commitImport(db, buf(DC_CSV), {
    accountName: 'Cards',
    overrides: {
      columnMap: { date: 0, debit: 1, credit: 2, payee: 3, description: 4 },
      amountMode: 'split_dc',
    },
  });
  assert.equal(r.importedCount, 3);
  assert.equal(r.errorCount, 0);
  const amounts = db
    .prepare('SELECT amount_minor FROM transactions ORDER BY date')
    .all()
    .map((x) => x.amount_minor);
  assert.deepEqual(amounts, [-1000, 25000, -320]);
  const payees = db.prepare('SELECT payee FROM transactions ORDER BY date').all().map((x) => x.payee);
  assert.deepEqual(payees, ['Kroger', 'ACME Corp', 'Metro Transit']);
});

test('inflow_outflow alias behaves like split_dc', () => {
  const db = setup();
  const r = commitImport(db, buf(DC_CSV), {
    accountName: 'Flow',
    overrides: {
      columnMap: { date: 0, debit: 1, credit: 2 },
      amountMode: 'inflow_outflow',
    },
  });
  assert.equal(r.importedCount, 3);
  const amounts = db
    .prepare('SELECT amount_minor FROM transactions ORDER BY date')
    .all()
    .map((x) => x.amount_minor);
  assert.deepEqual(amounts, [-1000, 25000, -320]);
});

test('split_dc zero and double-populated rows land in errors[], rest imports', () => {
  const db = setup();
  const csv = [
    'Date,Debit,Credit,Payee',
    '14/01/2027,5.00,,Alpha',
    '15/01/2027,,,Beta',
    '16/01/2027,1.00,2.00,Gamma',
    '17/01/2027,7.00,,Delta',
  ].join('\n');
  const r = commitImport(db, buf(csv), {
    accountName: 'Err',
    overrides: { columnMap: { date: 0, debit: 1, credit: 2, payee: 3 }, amountMode: 'split_dc' },
  });
  assert.equal(r.importedCount, 2);
  assert.equal(r.errorCount, 2);
  assert.deepEqual(
    r.details.errors.map((e) => e.rowIndex),
    [2, 3],
  );
  assert.match(r.details.errors[0].message, /empty/);
  assert.match(r.details.errors[1].message, /both/);
  const payees = db.prepare('SELECT payee FROM transactions ORDER BY date').all().map((x) => x.payee);
  assert.deepEqual(payees, ['Alpha', 'Delta']);
});

test('quoted fields with embedded commas parse as single fields', () => {
  const db = setup();
  const csv = [
    'Date,Amount,Payee,Note',
    '25/12/2026,-10.00,"Smith, John & Co","Gift, wrapping"',
  ].join('\n');
  const p = previewImport(db, buf(csv));
  assert.deepEqual(p.headerLabels, ['Date', 'Amount', 'Payee', 'Note']);
  assert.equal(p.sampleRows[0].payee, 'Smith, John & Co');
  assert.equal(p.sampleRows[0].description, 'Gift, wrapping');

  const r = commitImport(db, buf(csv), { accountName: 'Quotes' });
  assert.equal(r.importedCount, 1);
  const row = db.prepare('SELECT payee, description FROM transactions').get();
  assert.equal(row.payee, 'Smith, John & Co');
  assert.equal(row.description, 'Gift, wrapping');
});

test('trailing summary rows are skipped and recorded', () => {
  const db = setup();
  const csv = [
    'Date,Amount,Payee',
    '25/12/2026,-5.00,Cafe',
    '26/12/2026,-6.00,Bar',
    'Ending Balance,,,',
    'Total,,,',
  ].join('\n');
  const p = previewImport(db, buf(csv));
  assert.equal(p.rowCount, 2);
  const r = commitImport(db, buf(csv), { accountName: 'Sum' });
  assert.equal(r.importedCount, 2);
  assert.equal(r.rowCount, 2);
  assert.deepEqual(r.details.summaryRowsSkipped, [3, 4]);
});

test('leading junk metadata before header is skipped', () => {
  const db = setup();
  const csv = [
    'MyBank Statement',
    'Exported on 31/01/2027',
    '',
    'Date,Amount,Payee',
    '25/12/2026,-5.00,Cafe',
  ].join('\n');
  const p = previewImport(db, buf(csv));
  assert.equal(p.headerRowIndex, 2);
  assert.deepEqual(p.headerLabels, ['Date', 'Amount', 'Payee']);
  const r = commitImport(db, buf(csv), { accountName: 'Junk' });
  assert.equal(r.importedCount, 1);
});

test('BOM-prefixed UTF-8 decodes cleanly', () => {
  const db = setup();
  const p = previewImport(db, bomBuf(SIGNED_CSV));
  assert.equal(p.encoding, 'utf-8');
  assert.equal(p.headerLabels[0], 'Date');
  assert.equal(p.sampleRows[0].dateRaw, '25/12/2026');
  const r = commitImport(db, bomBuf(SIGNED_CSV), { accountName: 'BomAcct' });
  assert.equal(r.importedCount, 3);
});

test('duplicate overlap re-import skips all existing rows with reasons', () => {
  const db = setup();
  const opts = { accountName: 'Dupes' };
  const r1 = commitImport(db, buf(SIGNED_CSV), opts);
  assert.equal(r1.importedCount, 3);

  const r2 = commitImport(db, buf(SIGNED_CSV), opts);
  assert.equal(Number.isInteger(r2.fileId), true);
  assert.equal(r2.importedCount, 0);
  assert.equal(r2.skippedCount, 3);
  assert.ok(r2.details.skipped.every((s) => s.reason === 'duplicate'));
  for (const s of r2.details.skipped) {
    assert.match(s.fingerprint, /^[0-9a-f]{64}(#\d+)?$/);
  }
  assert.equal(counts(db).txns, 3);
});

test('genuinely distinct identical purchases both survive on fresh DB', () => {
  const db = setup();
  const csv = [
    'Date,Amount,Payee',
    '05/06/2026,-4.50,Coffee Bar',
    '05/06/2026,-4.50,Coffee Bar',
  ].join('\n');
  const r = commitImport(db, buf(csv), { accountName: 'Coffee', dateFormat: 'dmy' });
  assert.equal(r.importedCount, 2);
  assert.equal(r.skippedCount, 0);
  assert.equal(counts(db).txns, 2);
});

test('ambiguous dates throw AMBIGUOUS_DATES listing examples; preview flags ambiguity', () => {
  const db = setup();
  const csv = [
    'Date,Amount,Payee',
    '05/06/2026,-4.50,Coffee Bar',
    '11/12/2026,-2.25,Bagel Bros',
  ].join('\n');
  const p = previewImport(db, buf(csv));
  assert.equal(p.dateAmbiguous, true);
  assert.deepEqual([...p.dateFormatCandidates].sort(), ['dmy', 'mdy']);

  assert.throws(
    () => commitImport(db, buf(csv), { accountName: 'Amb' }),
    (e) => e instanceof ImportError && e.code === 'AMBIGUOUS_DATES' && /05\/06\/2026/.test(e.message),
  );
});

test('explicit dateFormat disambiguates dmy vs mdy incl 25/12 and 12/25', () => {
  const db = setup();

  const amb = [
    'Date,Amount,Payee',
    '05/06/2026,-4.50,Coffee Bar',
    '11/12/2026,-2.25,Bagel Bros',
  ].join('\n');
  const ra = commitImport(db, buf(amb), { accountName: 'Amb', dateFormat: 'dmy' });
  assert.equal(ra.importedCount, 2);
  let dates = db.prepare('SELECT date FROM transactions ORDER BY date').all().map((x) => x.date);
  assert.deepEqual(dates, ['2026-06-05', '2026-12-11']);

  const dmyOnly = 'Date,Amount,Payee\n25/12/2026,-5.00,X\n';
  commitImport(db, buf(dmyOnly), { accountId: 1, dateFormat: 'dmy' });
  const rm = commitImport(db, buf('Date,Amount,Payee\n12/25/2026,-5.00,Y\n'), { accountId: 1, dateFormat: 'mdy' });
  assert.equal(rm.importedCount, 1);
  dates = db
    .prepare("SELECT date FROM transactions WHERE date = '2026-12-25'")
    .all()
    .map((x) => x.date);
  assert.equal(dates.length, 2);
});

test('unparsable amount lands in errors[] while other rows still import', () => {
  const db = setup();
  const csv = [
    'Date,Amount,Payee',
    '25/12/2026,-5.00,Cafe',
    '26/12/2026,N/A,Mystery Merchant',
    '27/12/2026,-7.25,Dive Bar',
  ].join('\n');
  const p = previewImport(db, buf(csv));
  assert.deepEqual(
    p.errors.map((e) => ({ rowIndex: e.rowIndex })),
    [{ rowIndex: 2 }],
  );

  const r = commitImport(db, buf(csv), { accountName: 'Partial' });
  assert.equal(r.importedCount, 2);
  assert.equal(r.errorCount, 1);
  assert.equal(r.details.errors[0].rowIndex, 2);
  assert.match(r.details.errors[0].message, /N\/A|amount/i);
  const amounts = db
    .prepare('SELECT amount_minor FROM transactions ORDER BY amount_minor')
    .all()
    .map((x) => x.amount_minor);
  assert.deepEqual(amounts, [-725, -500]);
  const f = db.prepare('SELECT error_count FROM import_files').get();
  assert.equal(f.error_count, 1);
});

test('dryRun reports would-be results but writes nothing', () => {
  const db = setup();
  const before = counts(db);
  const r = commitImport(db, buf(SIGNED_CSV), { accountName: 'Ghost Account', dryRun: true });
  assert.equal(r.fileId, null);
  assert.equal(r.importedCount, 3);
  assert.equal(r.skippedCount, 0);
  assert.equal(r.profileSaved, null);
  assert.deepEqual(counts(db), before);
});

test('atomicity: failure mid-insert rolls back everything and rethrows', () => {
  const db = setup();
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql, ...rest) => {
    if (/INSERT INTO transactions/.test(sql)) throw new Error('simulated insert failure');
    return origPrepare(sql, ...rest);
  };
  try {
    assert.throws(() => commitImport(db, buf(SIGNED_CSV), { accountName: 'Doomed' }), /simulated insert failure/);
  } finally {
    db.prepare = origPrepare;
  }
  assert.equal(counts(db).accounts, 0, 'account creation must be rolled back');
  assert.equal(counts(db).txns, 0);
  assert.equal(counts(db).files, 0);

  db.prepare('INSERT INTO accounts (name) VALUES (?)').run('Still Usable');
  assert.equal(counts(db).accounts, 1);
});

test('malformed structure throws before any write', () => {
  const db = setup();
  const before = counts(db);

  assert.throws(
    () => commitImport(db, buf('foo,bar\nbaz,qux\n'), { accountName: 'X' }),
    (e) => e instanceof ImportError && e.code === 'NO_DATE_COLUMN',
  );
  assert.throws(
    () => commitImport(db, '', { accountName: 'X' }),
    (e) => e instanceof ImportError && e.code === 'EMPTY_FILE',
  );
  assert.throws(
    () =>
      commitImport(db, buf(SIGNED_CSV), {
        accountName: 'X',
        overrides: { columnMap: { date: 0, payee: 2 } },
      }),
    (e) => e instanceof ImportError && e.code === 'MISSING_COLUMNS',
  );
  assert.throws(
    () => commitImport(db, buf(SIGNED_CSV), {}),
    (e) => e instanceof ImportError && e.code === 'NO_ACCOUNT',
  );
  assert.throws(
    () => commitImport(db, buf(SIGNED_CSV), { accountId: 999 }),
    (e) => e instanceof ImportError && e.code === 'ACCOUNT_NOT_FOUND',
  );
  assert.throws(
    () => previewImport(db, buf(SIGNED_CSV), { profileId: 999 }),
    (e) => e instanceof ImportError && e.code === 'PROFILE_NOT_FOUND',
  );
  assert.throws(
    () =>
      commitImport(db, buf(SIGNED_CSV), {
        accountName: 'X',
        overrides: { skipPatterns: ['([bad'] },
      }),
    (e) => e instanceof ImportError && e.code === 'INVALID_SKIP_PATTERN',
  );
  assert.deepEqual(counts(db), before);
});

test('skipPatterns remove matching data rows and are logged in summaryRowsSkipped', () => {
  const db = setup();
  const csv = [
    'Date,Amount,Payee',
    '25/12/2026,-5.00,Cafe',
    '25/12/2026,1.10,Interest Payment',
    '27/12/2026,-7.00,Bar',
  ].join('\n');
  const opts = { accountName: 'Skip', overrides: { skipPatterns: ['interest payment'] } };
  const p = previewImport(db, buf(csv), opts);
  assert.equal(p.rowCount, 2);
  const r = commitImport(db, buf(csv), opts);
  assert.equal(r.importedCount, 2);
  assert.deepEqual(r.details.summaryRowsSkipped, [2]);
});

test('commitImport saves a named profile; profileId reuse applies stored mapping', () => {
  const db = setup();
  const r1 = commitImport(db, buf(SIGNED_CSV), { accountName: 'MainBank', profileName: 'MainBank CSV' });
  assert.equal(r1.profileSaved, 'MainBank CSV');
  const prof = db.prepare('SELECT * FROM profiles WHERE name = ?').get('MainBank CSV');
  assert.ok(prof);
  assert.deepEqual(JSON.parse(prof.column_map), { date: 0, amount: 1, payee: 2, description: 3 });
  assert.equal(prof.date_format, 'dmy');
  assert.equal(prof.delimiter, ',');

  const more = 'Date,Amount,Payee,Note\n02/01/2027,-3.75,Kiosk,snack\n';
  const r2 = commitImport(db, buf(more), { profileId: Number(prof.id), accountName: 'MainBank' });
  assert.equal(r2.importedCount, 1);
  assert.equal(r2.profileSaved, null);
  const row = db.prepare('SELECT date, amount_minor FROM transactions WHERE payee = ?').get('Kiosk');
  assert.deepEqual({ ...row }, { date: '2027-01-02', amount_minor: -375 });

  const again = commitImport(db, buf(more), {
    profileId: Number(prof.id),
    accountName: 'MainBank',
    profileName: 'MainBank CSV Renamed',
  });
  assert.equal(again.profileSaved, 'MainBank CSV Renamed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n, 1);
  assert.equal(getProfileName(db, prof.id), 'MainBank CSV Renamed');
});

function getProfileName(db, id) {
  return db.prepare('SELECT name FROM profiles WHERE id = ?').get(id).name;
}

test('preview of an empty buffer returns a zeroed report without throwing', () => {
  const db = setup();
  const p = previewImport(db, Buffer.alloc(0));
  assert.equal(p.rowCount, 0);
  assert.deepEqual(p.headerLabels, []);
  assert.equal(p.columnMapGuess, null);
  assert.deepEqual(p.errors, []);
});

test('importProgressChunks computes chunk counts', () => {
  assert.equal(importProgressChunks(0), 0);
  assert.equal(importProgressChunks(1), 1);
  assert.equal(importProgressChunks(500), 1);
  assert.equal(importProgressChunks(501), 2);
  assert.equal(importProgressChunks(1000), 2);
  assert.equal(importProgressChunks(1250), 3);
  assert.equal(importProgressChunks(101, 100), 2);
  assert.equal(importProgressChunks(200, 100), 2);
  assert.throws(() => importProgressChunks(-1), TypeError);
  assert.throws(() => importProgressChunks(10, 0), TypeError);
  assert.throws(() => importProgressChunks(10.5), TypeError);
});

test('auto-categorization records rule application when engine is available', (t) => {
  if (!engineAvailable) return t.skip('src/rules/engine.js not implemented yet');
  const db = setup();
  const r = commitImport(db, buf(SIGNED_CSV), { accountName: 'Categorized' });
  assert.equal(r.importedCount, 3);
  const rows = db
    .prepare('SELECT category_id, category_source, applied_rule_id FROM transactions')
    .all();
  for (const row of rows) {
    if (row.category_id != null) {
      assert.ok(['rule', 'learned'].includes(row.category_source));
      assert.ok(row.applied_rule_id != null);
    } else {
      assert.equal(row.category_source, null);
      assert.equal(row.applied_rule_id, null);
    }
  }
});
