import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import {
  saveProfile,
  listProfiles,
  getProfile,
  deleteProfile,
  updateProfile,
} from '../src/import/profiles.js';

function setup() {
  const db = openDb(':memory:');
  seedTaxonomy(db);
  return db;
}

function baseConfig(over = {}) {
  return { name: 'P1', delimiter: ',', dateFormat: 'dmy', columnMap: { date: 0, amount: 1 }, ...over };
}

test('saveProfile returns an integer id and getProfile hydrates JSON fields', () => {
  const db = setup();
  const id = saveProfile(db, {
    name: 'ACME Bank',
    delimiter: ';',
    encoding: 'windows-1252',
    headerRow: 2,
    dateFormat: 'mdy',
    columnMap: { date: 0, debit: 1, credit: 2, payee: 3, description: 4 },
    amountMode: 'split_dc',
    skipPatterns: ['^interest payment$', '^total'],
  });
  assert.equal(Number.isInteger(id), true);

  const p = getProfile(db, id);
  assert.equal(p.name, 'ACME Bank');
  assert.equal(p.delimiter, ';');
  assert.equal(p.encoding, 'windows-1252');
  assert.equal(p.headerRow, 2);
  assert.equal(p.dateFormat, 'mdy');
  assert.deepEqual(p.columnMap, { date: 0, debit: 1, credit: 2, payee: 3, description: 4 });
  assert.equal(p.amountMode, 'split_dc');
  assert.deepEqual(p.skipPatterns, ['^interest payment$', '^total']);
  assert.match(p.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('saveProfile applies documented defaults', () => {
  const db = setup();
  const id = saveProfile(db, baseConfig());
  const p = getProfile(db, id);
  assert.equal(p.encoding, 'utf-8');
  assert.equal(p.headerRow, 0);
  assert.equal(p.amountMode, 'signed');
  assert.deepEqual(p.skipPatterns, []);
});

test('saveProfile ids autoincrement; listProfiles returns all hydrated rows', () => {
  const db = setup();
  const a = saveProfile(db, baseConfig({ name: 'A' }));
  const b = saveProfile(db, baseConfig({ name: 'B', delimiter: '\t' }));
  assert.ok(b > a);
  const all = listProfiles(db);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((p) => p.name), ['A', 'B']);
  assert.deepEqual(all[1].columnMap, { date: 0, amount: 1 });
});

test('getProfile / deleteProfile / updateProfile on missing id behave', () => {
  const db = setup();
  assert.equal(getProfile(db, 42), undefined);
  assert.equal(updateProfile(db, 42, { delimiter: ';' }), undefined);
  assert.equal(deleteProfile(db, 42), false);
});

test('deleteProfile removes and reports', () => {
  const db = setup();
  const id = saveProfile(db, baseConfig());
  assert.equal(deleteProfile(db, id), true);
  assert.equal(deleteProfile(db, id), false);
  assert.equal(getProfile(db, id), undefined);
});

test('updateProfile merges patch and revalidates the merged config', () => {
  const db = setup();
  const id = saveProfile(db, baseConfig({ skipPatterns: [] }));
  const updated = updateProfile(db, id, { delimiter: '|', skipPatterns: ['^balance'], headerRow: 3 });
  assert.equal(updated.delimiter, '|');
  assert.equal(updated.headerRow, 3);
  assert.deepEqual(updated.skipPatterns, ['^balance']);
  assert.equal(updated.dateFormat, 'dmy');
  assert.deepEqual(updated.columnMap, { date: 0, amount: 1 });

  assert.throws(() => updateProfile(db, id, { columnMap: { payee: 0 } }), TypeError);
  assert.equal(getProfile(db, id).delimiter, '|');

  assert.throws(() => updateProfile(db, id, { bogus: 1 }), TypeError);
  assert.throws(() => updateProfile(db, id, 'nope'), TypeError);
});

test('saveProfile rejects invalid configs (types and required map fields)', () => {
  const db = setup();
  const cases = [
    null,
    'x',
    { delimiter: ',', dateFormat: 'dmy', columnMap: { date: 0, amount: 1 } },
    baseConfig({ name: '' }),
    baseConfig({ name: '   ' }),
    baseConfig({ delimiter: 'x' }),
    baseConfig({ delimiter: missing() }),
    baseConfig({ encoding: 'iso-8859-1' }),
    baseConfig({ headerRow: -1 }),
    baseConfig({ headerRow: 1.5 }),
    baseConfig({ headerRow: '0' }),
    baseConfig({ dateFormat: 'ddmmyyyy' }),
    baseConfig({ dateFormat: missing() }),
    baseConfig({ amountMode: 'auto' }),
    baseConfig({ columnMap: null }),
    baseConfig({ columnMap: [0, 1] }),
    baseConfig({ columnMap: {} }),
    baseConfig({ columnMap: { amount: 1 } }),
    baseConfig({ columnMap: { date: 0 } }),
    baseConfig({ columnMap: { date: 0, memo: 5, amount: 1 } }),
    baseConfig({ columnMap: { date: -1, amount: 1 } }),
    baseConfig({ columnMap: { date: 0.5, amount: 1 } }),
    baseConfig({ columnMap: { date: 0, amount: 1, credit: '2' } }),
    baseConfig({ columnMap: { date: 0, debit: 1 } }),
    baseConfig({ amountMode: 'split_dc', columnMap: { date: 0, amount: 1 } }),
    baseConfig({ amountMode: 'inflow_outflow', columnMap: { date: 0, amount: 1 } }),
    baseConfig({ skipPatterns: 'nope' }),
    baseConfig({ skipPatterns: [1] }),
  ];
  for (const cfg of cases) {
    assert.throws(() => saveProfile(db, cfg), TypeError, `expected TypeError for ${JSON.stringify(cfg)}`);
  }
  function missing() {
    return undefined;
  }
});

test('valid split/inflow column maps are accepted', () => {
  const db = setup();
  saveProfile(db, baseConfig({ name: 'dc', amountMode: 'split_dc', columnMap: { date: 0, debit: 1 } }));
  saveProfile(
    db,
    baseConfig({ name: 'io', amountMode: 'inflow_outflow', columnMap: { date: 0, debit: 1, credit: 2 } }),
  );
  assert.equal(listProfiles(db).length, 2);
});

test('profile names are unique at the DB level', () => {
  const db = setup();
  saveProfile(db, baseConfig({ name: 'Dup' }));
  assert.throws(() => saveProfile(db, baseConfig({ name: 'Dup' })));
});
