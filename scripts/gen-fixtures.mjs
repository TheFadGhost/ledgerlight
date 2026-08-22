import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

function isoFromUtcMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

const JAN_1 = Date.UTC(2026, 0, 1);
const MAR_31 = Date.UTC(2026, 2, 31);

const ONE_OFF_PAYEES = [
  'Fake Coffee Co',
  'TEST Mart',
  'Sample Gas & Go',
  'Pretend Pharmacy',
  'Mock Bookseller',
  'Hypothetical Hardware',
  'Placeholder Produce',
  'Synthetic Sandwich Shop',
];

const MEMOS = [
  'Card purchase',
  'Online order',
  'Weekly shop',
  'Auto payment',
  'Store pickup',
  'Service fee',
];

function makeTxns(seed) {
  const rng = mulberry32(seed);
  const txns = [];

  const streamJitter = [0, 25, -25, 50];
  for (const [m, d] of [['01', 12], ['02', 12], ['03', 13]]) {
    txns.push({
      iso: `2026-${m}-${pad2(d)}`,
      payee: 'Demo Streaming',
      memo: 'Subscription plan',
      amt: -(1599 + streamJitter[Math.floor(rng() * streamJitter.length)]),
    });
  }

  for (let t = Date.UTC(2026, 0, 5); t <= MAR_31; t += 7 * 86400000) {
    txns.push({ iso: isoFromUtcMs(t), payee: 'Fake Gym', memo: 'Weekly membership', amt: -2999 });
  }

  for (const iso of ['2026-01-30', '2026-02-27', '2026-03-31']) {
    txns.push({
      iso,
      payee: 'Test Employer Payroll',
      memo: 'Salary deposit ACCT-0001112223',
      amt: 250000,
    });
  }

  txns.push({
    iso: `2026-0${1 + Math.floor(rng() * 3)}-${pad2(2 + Math.floor(rng() * 26))}`,
    payee: 'Demo Utilities',
    memo: 'Billing correction refund',
    amt: 1240,
  });

  const oneOffCount = 7 + Math.floor(rng() * 4);
  for (let i = 0; i < oneOffCount; i++) {
    txns.push({
      iso: isoFromUtcMs(JAN_1 + Math.floor(rng() * 90) * 86400000),
      payee: ONE_OFF_PAYEES[Math.floor(rng() * ONE_OFF_PAYEES.length)],
      memo: MEMOS[Math.floor(rng() * MEMOS.length)],
      amt: -(350 + Math.floor(rng() * 8555)),
    });
  }

  txns.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
  return txns;
}

function fmtDate(iso, style) {
  const [y, m, d] = iso.split('-');
  if (style === 'dmy') return `${d}/${m}/${y}`;
  if (style === 'mdy') return `${m}/${d}/${y}`;
  return iso;
}

function fmtPlain(minor) {
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function fmtEu(minor) {
  const abs = Math.abs(minor);
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${minor < 0 ? '-' : ''}${int},${String(abs % 100).padStart(2, '0')}`;
}

function fmtParenUs(minor) {
  const abs = Math.abs(minor);
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const num = `$${int}.${String(abs % 100).padStart(2, '0')}`;
  return minor < 0 ? `(${num})` : num;
}

function csvField(value, delim) {
  const s = String(value);
  if (s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delim)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function render(header, rows, delim, eol) {
  const lines = [header.map((c) => csvField(c, delim)).join(delim)];
  for (const r of rows) lines.push(r.map((c) => csvField(c, delim)).join(delim));
  return lines.join(eol) + eol;
}

const FIXTURES = [
  {
    name: '01-quoted-commas.csv',
    build() {
      const txns = makeTxns(101);
      const oneOffs = txns.filter((t) => ONE_OFF_PAYEES.includes(t.payee));
      oneOffs[0].memo = 'latte, croissant, and tip';
      oneOffs[1].memo = 'produce, dairy, and snacks';
      const febStream = txns.find((t) => t.payee === 'Demo Streaming' && t.iso === '2026-02-12');
      febStream.memo = 'Monthly plan\n(promo rate applied)';
      txns.push(
        { iso: '2026-02-14', payee: 'Fake Coffee Co', memo: 'latte and pastry, extra shot', amt: -475 },
        { iso: '2026-02-14', payee: 'Fake Coffee Co', memo: 'latte and pastry, extra shot', amt: -475 },
      );
      txns.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
      const rows = txns.map((t) => [fmtDate(t.iso, 'mdy'), t.payee, fmtPlain(t.amt), t.memo]);
      return Buffer.from(render(['Date', 'Payee', 'Amount', 'Memo'], rows, ',', '\n'), 'utf8');
    },
  },
  {
    name: '02-bom-utf8.csv',
    build() {
      const txns = makeTxns(102);
      const oneOffs = txns.filter((t) => ONE_OFF_PAYEES.includes(t.payee));
      oneOffs[0].payee = 'Café Crêpe Faux';
      oneOffs[1].payee = 'Pharmacie Fictive';
      oneOffs[2].payee = 'Bäckerei Beispiel';
      const rows = txns.map((t, i) => [
        fmtDate(t.iso, 'dmy'),
        t.payee,
        `REF-${String(i + 1).padStart(4, '0')}`,
        fmtPlain(t.amt),
      ]);
      return Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(render(['Date', 'Payee', 'Reference', 'Amount'], rows, ',', '\n'), 'utf8'),
      ]);
    },
  },
  {
    name: '03-crlf.csv',
    build() {
      const txns = makeTxns(103);
      const rows = txns.map((t) => [fmtDate(t.iso, 'ymd'), `${t.payee} - ${t.memo}`, fmtPlain(t.amt)]);
      return Buffer.from(render(['Date', 'Description', 'Amount'], rows, ',', '\r\n'), 'utf8');
    },
  },
  {
    name: '04-semicolon-decimal-comma.csv',
    build() {
      const txns = makeTxns(104);
      const clean = (s) => s.replace(/[;",\r\n]/g, '');
      const rows = txns.map((t) => [
        fmtDate(t.iso, 'dmy'),
        t.payee,
        clean(t.memo),
        fmtEu(t.amt),
      ]);
      return Buffer.from(render(['Date', 'Payee', 'Description', 'Amount'], rows, ';', '\n'), 'utf8');
    },
  },
  {
    name: '05-parentheses-negatives.csv',
    build() {
      const txns = makeTxns(105);
      const rows = txns.map((t) => [fmtDate(t.iso, 'ymd'), t.payee, fmtParenUs(t.amt)]);
      return Buffer.from(render(['Transaction Date', 'Merchant', 'Amount'], rows, ',', '\n'), 'utf8');
    },
  },
  {
    name: '06-debit-credit-columns.csv',
    build() {
      const txns = makeTxns(106);
      txns.push(
        { iso: '2026-02-10', payee: 'TEST Mart', memo: 'duplicate posting - both populated', both: true },
        { iso: '2026-02-21', payee: 'Fake Coffee Co', memo: 'missing amount - neither populated', neither: true },
      );
      txns.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
      const rows = txns.map((t) => {
        if (t.both) return [fmtDate(t.iso, 'mdy'), t.payee, '25.00', '25.00', t.memo];
        if (t.neither) return [fmtDate(t.iso, 'mdy'), t.payee, '', '', t.memo];
        return [
          fmtDate(t.iso, 'mdy'),
          t.payee,
          t.amt < 0 ? fmtPlain(-t.amt) : '',
          t.amt > 0 ? fmtPlain(t.amt) : '',
          t.memo,
        ];
      });
      return Buffer.from(render(['Date', 'Payee', 'Debit', 'Credit', 'Memo'], rows, ',', '\n'), 'utf8');
    },
  },
  {
    name: '07-trailing-summary.csv',
    build() {
      const txns = makeTxns(107);
      const rows = txns.map((t) => [fmtDate(t.iso, 'ymd'), t.payee, fmtPlain(t.amt)]);
      const body = render(['Date', 'Payee', 'Amount'], rows, ',', '\n');
      return Buffer.from(`${body}\nTotal,,12345.67\nEnding Balance,,12345.67\n`, 'utf8');
    },
  },
  {
    name: '08-metadata-header-junk.csv',
    build() {
      const txns = makeTxns(108);
      const rows = txns.map((t) => [
        fmtDate(t.iso, 'dmy'),
        `${t.payee} (${t.memo})`,
        fmtPlain(t.amt),
      ]);
      const lines = [
        'Account: TEST-ACCT-99',
        'Statement Period: 2026-01-01 to 2026-03-31',
        '',
        'Posting Date,Details,Amount',
        ...rows.map((r) => r.map((c) => csvField(c, ',')).join(',')),
      ];
      return Buffer.from(lines.join('\n') + '\n', 'utf8');
    },
  },
  {
    name: '09-tab-delimited.txt',
    build() {
      const txns = makeTxns(109);
      const rows = txns.map((t) => [fmtDate(t.iso, 'ymd'), t.payee, fmtPlain(t.amt), t.memo]);
      return Buffer.from(render(['Date', 'Payee', 'Amount', 'Memo'], rows, '\t', '\n'), 'utf8');
    },
  },
  {
    name: '10-utf16le.csv',
    build() {
      const txns = makeTxns(110);
      const oneOffs = txns.filter((t) => ONE_OFF_PAYEES.includes(t.payee));
      oneOffs[0].payee = 'Café Démo';
      const rows = txns.map((t) => [fmtDate(t.iso, 'mdy'), t.payee, t.memo, fmtPlain(t.amt)]);
      return Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(render(['Date', 'Payee', 'Memo', 'Amount'], rows, ',', '\n'), 'utf16le'),
      ]);
    },
  },
];

export const FIXTURE_NAMES = FIXTURES.map((f) => f.name);

export async function generateAll(outDir = 'fixtures') {
  const resolved = isAbsolute(outDir) ? outDir : join(ROOT, outDir);
  mkdirSync(resolved, { recursive: true });
  const written = [];
  for (const f of FIXTURES) {
    writeFileSync(join(resolved, f.name), f.build());
    written.push(f.name);
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = process.argv[2] ?? 'fixtures';
  const files = await generateAll(outDir);
  console.log(`wrote ${files.length} fixtures to ${outDir}`);
}
