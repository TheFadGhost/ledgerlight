import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateAll, FIXTURE_NAMES } from '../scripts/gen-fixtures.mjs';
import { decodeBuffer } from '../src/csv/decode.js';
import { parseCsv } from '../src/csv/parse.js';
import { looksLikeSummaryRow } from '../src/csv/detect.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = join(ROOT, 'fixtures');

const DATE_STYLE = {
  '01-quoted-commas.csv': 'mdy',
  '02-bom-utf8.csv': 'dmy',
  '03-crlf.csv': 'ymd',
  '04-semicolon-decimal-comma.csv': 'dmy',
  '05-parentheses-negatives.csv': 'ymd',
  '06-debit-credit-columns.csv': 'mdy',
  '07-trailing-summary.csv': 'ymd',
  '08-metadata-header-junk.csv': 'dmy',
  '09-tab-delimited.txt': 'ymd',
  '10-utf16le.csv': 'mdy',
};

const DELIMITERS = {
  '01-quoted-commas.csv': ',',
  '02-bom-utf8.csv': ',',
  '03-crlf.csv': ',',
  '04-semicolon-decimal-comma.csv': ';',
  '05-parentheses-negatives.csv': ',',
  '06-debit-credit-columns.csv': ',',
  '07-trailing-summary.csv': ',',
  '08-metadata-header-junk.csv': ',',
  '09-tab-delimited.txt': '\t',
  '10-utf16le.csv': ',',
};

function load(name) {
  const buf = readFileSync(join(FIXTURES_DIR, name));
  return { buf, text: decodeBuffer(buf).text };
}

function readAll(dir) {
  return Object.fromEntries(FIXTURE_NAMES.map((n) => [n, readFileSync(join(dir, n))]));
}

test('CLI run writes all ten fixtures into fixtures/', () => {
  execFileSync(process.execPath, ['scripts/gen-fixtures.mjs'], { cwd: ROOT });
  for (const name of FIXTURE_NAMES) {
    assert.equal(existsSync(join(FIXTURES_DIR, name)), true, `missing ${name}`);
  }
});

test('generateAll reports exactly the expected filenames', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerlight-fixtures-named-'));
  try {
    assert.deepEqual(await generateAll(dir), FIXTURE_NAMES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generation is byte-deterministic across reruns and directories', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'ledgerlight-fixtures-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'ledgerlight-fixtures-b-'));
  try {
    await generateAll(dirA);
    const first = readAll(dirA);
    await generateAll(dirB);
    const second = readAll(dirB);
    await generateAll(dirA);
    const third = readAll(dirA);
    for (const name of FIXTURE_NAMES) {
      assert.ok(first[name].equals(second[name]), `nondeterministic across dirs: ${name}`);
      assert.ok(first[name].equals(third[name]), `nondeterministic across reruns: ${name}`);
    }
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('every fixture parses with >10 data rows, consistent dates, and recurring anchors', () => {
  const dateRes = { dmy: /^\d{2}\/\d{2}\/\d{4}$/, mdy: /^\d{2}\/\d{2}\/\d{4}$/, ymd: /^\d{4}-\d{2}-\d{2}$/ };
  for (const name of FIXTURE_NAMES) {
    const { buf, text } = load(name);
    assert.ok(buf.length > 500, `${name}: suspiciously small`);
    const { rows } = parseCsv(text);
    assert.ok(rows.length >= 16 && rows.length <= 41, `${name}: unexpected row count ${rows.length}`);
    const style = DATE_STYLE[name];
    const dateCells = rows.map((r) => r[0]).filter((v) => dateRes[style].test(v));
    assert.ok(dateCells.length >= 15, `${name}: dates not consistently ${style}`);
    const count = (s) => text.split(s).length - 1;
    assert.ok(count('Demo Streaming') >= 3, `${name}: missing monthly recurring anchor`);
    assert.ok(count('Fake Gym') >= 10, `${name}: missing weekly recurring anchor`);
  }
});

test('delimiter detection matches each fixture design', () => {
  for (const [name, delim] of Object.entries(DELIMITERS)) {
    const { text } = load(name);
    assert.equal(parseCsv(text).delimiter, delim, `${name}: delimiter mismatch`);
  }
});

test('BOMs present exactly where required', () => {
  for (const name of FIXTURE_NAMES) {
    const { buf } = load(name);
    const utf8Bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const utf16Bom = buf[0] === 0xff && buf[1] === 0xfe;
    if (name === '02-bom-utf8.csv') {
      assert.ok(utf8Bom, `${name}: UTF-8 BOM missing`);
      const decoded = decodeBuffer(buf);
      assert.equal(decoded.encoding, 'utf-8');
      assert.match(decoded.text, /Café Crêpe Faux/);
    } else if (name === '10-utf16le.csv') {
      assert.ok(utf16Bom, `${name}: UTF-16LE BOM missing`);
      const decoded = decodeBuffer(buf);
      assert.equal(decoded.encoding, 'utf-16le');
      assert.match(decoded.text, /Café Démo/);
    } else {
      assert.ok(!utf8Bom && !utf16Bom, `${name} unexpectedly has a BOM`);
    }
  }
});

test('01-quoted-commas.csv keeps quoted commas, embedded newline, and a duplicate purchase pair', () => {
  const { rows } = parseCsv(load('01-quoted-commas.csv').text);
  const dataRows = rows.slice(1);
  assert.ok(dataRows.some((r) => r.some((c) => c.includes(','))), 'no comma-bearing field');
  assert.ok(dataRows.some((r) => r.some((c) => c.includes('\n'))), 'no embedded newline memo');
  const keys = dataRows.map((r) => `${r[0]}|${r[1]}|${r[2]}`);
  const counts = new Map();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  assert.ok([...counts.values()].some((n) => n >= 2), 'no identical same-day same-amount pair');
});

test('03-crlf.csv uses CRLF line endings exclusively', () => {
  const raw = readFileSync(join(FIXTURES_DIR, '03-crlf.csv')).toString('latin1');
  assert.ok(raw.includes('\r\n'), 'no CRLF found');
  assert.doesNotMatch(raw, /(?<!\r)\n/, 'bare LF found');
});

test('04-semicolon-decimal-comma.csv has grouped decimal-comma amounts and minus negatives', () => {
  const { text } = load('04-semicolon-decimal-comma.csv');
  assert.match(text, /\d{1,3}(?:\.\d{3})+,\d{2}$/m, 'no dot-grouped comma-decimal amount');
  assert.match(text, /(?:^|;)-\d+,\d{2}$/m, 'no leading-minus negative');
});

test('05-parentheses-negatives.csv has paren negatives, $ symbols, and thousands separators', () => {
  const { text } = load('05-parentheses-negatives.csv');
  assert.match(text, /\(\$\d+\.\d{2}\)/, 'no parenthesized negative');
  assert.match(text, /\$\d{1,3}(?:,\d{3})+\.\d{2}/, 'no grouped $ amount');
});

test('06-debit-credit-columns.csv includes both-populated and neither-populated error rows', () => {
  const { rows } = parseCsv(load('06-debit-credit-columns.csv').text);
  const hIdx = rows.findIndex((r) => r.includes('Debit') && r.includes('Credit'));
  const header = rows[hIdx];
  const d = header.indexOf('Debit');
  const c = header.indexOf('Credit');
  const dateIdx = header.indexOf('Date');
  const dataRows = rows.slice(hIdx + 1);
  assert.ok(dataRows.some((r) => r[d] !== '' && r[c] !== ''), 'no both-populated row');
  assert.ok(
    dataRows.some((r) => r[dateIdx] !== '' && r[d] === '' && r[c] === ''),
    'no neither-populated row',
  );
  assert.ok(dataRows.some((r) => r[d] !== '' && r[c] === ''), 'no debit-only row');
  assert.ok(dataRows.some((r) => r[c] !== '' && r[d] === ''), 'no credit-only row');
});

test('07-trailing-summary.csv carries Total and Ending Balance junk the parser can flag', () => {
  const { text } = load('07-trailing-summary.csv');
  assert.match(text, /^Total,/m);
  assert.match(text, /^Ending Balance,/m);
  const { rows } = parseCsv(text);
  assert.equal(looksLikeSummaryRow(rows.at(-1)), true, 'Ending Balance row not flagged as summary');
  assert.equal(looksLikeSummaryRow(rows.at(-2)), true, 'Total row not flagged as summary');
});

test('08-metadata-header-junk.csv leads with junk lines before the real header', () => {
  const { rows } = parseCsv(load('08-metadata-header-junk.csv').text);
  assert.deepEqual(rows[0], ['Account: TEST-ACCT-99']);
  assert.match(rows[1][0], /^Statement Period:/);
  assert.deepEqual(rows[2], ['Posting Date', 'Details', 'Amount']);
});

test('09-tab-delimited.txt is tab-separated with no comma ambiguity', () => {
  const raw = readFileSync(join(FIXTURES_DIR, '09-tab-delimited.txt')).toString('latin1');
  assert.ok(raw.includes('\t'), 'no tab found');
  assert.doesNotMatch(raw, /,/, 'unexpected comma');
});
