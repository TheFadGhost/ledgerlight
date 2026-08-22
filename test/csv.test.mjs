import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeBuffer } from '../src/csv/decode.js';
import { parseCsv } from '../src/csv/parse.js';
import {
  detectDelimiter,
  detectHeaderRow,
  detectDateFormat,
  detectAmountFormat,
  looksLikeSummaryRow,
} from '../src/csv/detect.js';

test('parseCsv: quoted commas, embedded newlines, escaped quotes', () => {
  const csv = 'payee,note,amount\n"Aldi, Ltd.","line1\nline2","say ""hi"""\n';
  const { rows, delimiter } = parseCsv(csv);
  assert.equal(delimiter, ',');
  assert.deepEqual(rows, [
    ['payee', 'note', 'amount'],
    ['Aldi, Ltd.', 'line1\nline2', 'say "hi"'],
  ]);
});

test('parseCsv: blank lines skipped, separator-only rows kept, trailing newline optional', () => {
  const { rows } = parseCsv('a,b\n\nc,d\n,,\ne,f');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['c', 'd'],
    ['', '', ''],
    ['e', 'f'],
  ]);
});

test('parseCsv: no rows fabricated for empty input or trailing newlines', () => {
  assert.deepEqual(parseCsv('').rows, []);
  assert.deepEqual(parseCsv('\n\n').rows, []);
  assert.deepEqual(parseCsv('a,b\n').rows, [['a', 'b']]);
  assert.deepEqual(parseCsv('a,b').rows, [['a', 'b']]);
  assert.deepEqual(parseCsv('a,').rows, [['a', '']]);
});

test('parseCsv: CRLF and LF row endings are equivalent (and mixable)', () => {
  const crlf = parseCsv('a,b\r\nc,d\r\n').rows;
  const lf = parseCsv('a,b\nc,d\n').rows;
  const mixed = parseCsv('a,b\nc,d\r\n').rows;
  const unterminated = parseCsv('a,b\nc,d').rows;
  const expected = [
    ['a', 'b'],
    ['c', 'd'],
  ];
  assert.deepEqual(crlf, expected);
  assert.deepEqual(lf, expected);
  assert.deepEqual(mixed, expected);
  assert.deepEqual(unterminated, expected);
});

test('decodeBuffer: UTF-8 BOM is stripped and round trips', () => {
  const buf = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('date,amount\nhéllo,1.50\n', 'utf8'),
  ]);
  const { text, encoding } = decodeBuffer(buf);
  assert.equal(encoding, 'utf-8');
  assert.equal(text, 'date,amount\nhéllo,1.50\n');
});

test('decodeBuffer: UTF-16LE with BOM decodes and strips BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\n', 'utf16le')]);
  const { text, encoding } = decodeBuffer(buf);
  assert.equal(encoding, 'utf-16le');
  assert.equal(text, 'a,b\n');
});

test('decodeBuffer: invalid UTF-8 falls back to windows-1252 (smart quotes)', () => {
  const buf = Buffer.from([0x93, 0x41, 0x42, 0x94]);
  const { text, encoding } = decodeBuffer(buf);
  assert.equal(encoding, 'windows-1252');
  assert.equal(text, '\u201CAB\u201D');
});

test('detectDelimiter: comma, semicolon, tab, pipe; commas inside quotes ignored', () => {
  assert.equal(detectDelimiter('a,b\nc,d\n'), ',');
  assert.equal(detectDelimiter('a;b\nc;d\n'), ';');
  assert.equal(detectDelimiter('a\tb\nc\td\n'), '\t');
  assert.equal(detectDelimiter('a|b\nc|d\n'), '|');
  assert.equal(detectDelimiter('"Smith, John";12;34\n'), ';');
  assert.equal(detectDelimiter('a,b|c'), ',');
  assert.equal(parseCsv('a;b\nc;d\n').delimiter, ';');
  assert.equal(parseCsv('a\tb\nc\td\n').delimiter, '\t');
  assert.equal(parseCsv('a|b\nc|d\n').delimiter, '|');
});

test('detectHeaderRow: skips leading metadata junk rows to find the header', () => {
  const rows = [
    ['Account summary'],
    [],
    ['Date', 'Payee', 'Amount'],
    ['01/02/2026', 'Kiosk', '-3.50'],
  ];
  assert.equal(detectHeaderRow(rows), 2);
  assert.equal(detectHeaderRow([['Date', 'Amount'], ['2026-01-01', '5']]), 0);
  assert.equal(detectHeaderRow([]), 0);
});

test('detectDateFormat: ambiguity reported, never silently resolved', () => {
  assert.deepEqual(detectDateFormat(['03/04/2026']), {
    candidates: ['dmy', 'mdy'],
    ambiguous: true,
  });
  assert.deepEqual(detectDateFormat(['31/01/2026']), {
    candidates: ['dmy'],
    ambiguous: false,
  });
  assert.deepEqual(detectDateFormat(['2026-01-31']), {
    candidates: ['ymd'],
    ambiguous: false,
  });
});

test('detectAmountFormat: dot, comma, and integer-only ambiguity', () => {
  assert.deepEqual(detectAmountFormat(['1,234.56', '9.99']), {
    decimalHint: 'dot',
    ambiguous: false,
  });
  assert.deepEqual(detectAmountFormat(['1.234,56', '9,99']), {
    decimalHint: 'comma',
    ambiguous: false,
  });
  assert.deepEqual(detectAmountFormat(['100', '200']), {
    decimalHint: null,
    ambiguous: true,
  });
});

test('looksLikeSummaryRow: true for total/balance trailers, false for data rows', () => {
  assert.equal(looksLikeSummaryRow(['Total', '', '1234.56']), true);
  assert.equal(looksLikeSummaryRow(['Ending Balance', '500.00']), true);
  assert.equal(looksLikeSummaryRow(['BEGINNING BALANCE', '', '', '']), true);
  assert.equal(looksLikeSummaryRow(['Kiosk purchase', '', '-3.50']), false);
  assert.equal(looksLikeSummaryRow(['Totals included', '', '5']), false);
  assert.equal(looksLikeSummaryRow([]), false);
});

test('pipeline: decodeBuffer -> parseCsv on a BOM-prefixed semicolon file', () => {
  const body = 'Date;Payee;Amount\n31/01/2026;Café Central;-4,20\n';
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
  const { text } = decodeBuffer(buf);
  const { rows, delimiter } = parseCsv(text);
  assert.equal(delimiter, ';');
  assert.deepEqual(rows, [
    ['Date', 'Payee', 'Amount'],
    ['31/01/2026', 'Café Central', '-4,20'],
  ]);
});
