import { decodeBuffer } from '../csv/decode.js';
import { parseCsv } from '../csv/parse.js';
import {
  detectDelimiter,
  detectHeaderRow,
  detectDateFormat,
  detectAmountFormat,
  looksLikeSummaryRow,
} from '../csv/detect.js';
import { parseDateWithFormat, DATE_FORMATS } from '../core/dates.js';
import { parseAmountToMinor } from '../core/money.js';
import { planImport } from '../dedupe.js';
import { saveProfile, updateProfile, getProfile } from './profiles.js';
import { createRequire } from 'node:module';

const SAMPLE_LIMIT = 120;
const SAMPLE_ROW_COUNT = 8;
const COLUMN_FIELDS = ['date', 'amount', 'debit', 'credit', 'payee', 'description'];
const AMOUNT_MODES = ['signed', 'split_dc', 'inflow_outflow'];

export class ImportError extends Error {
  constructor(code, message, meta) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    if (meta !== undefined) this.meta = meta;
  }
}

let rulesEngine;
function loadRulesEngine() {
  if (rulesEngine !== undefined) return rulesEngine;
  try {
    rulesEngine = createRequire(import.meta.url)('../rules/engine.js');
  } catch {
    rulesEngine = null;
  }
  return rulesEngine;
}

function autoCategorize(db, inserts) {
  if (inserts.length === 0) return [];
  const uncategorized = () => inserts.map(() => null);
  const engine = loadRulesEngine();
  if (
    !engine ||
    typeof engine.compileRules !== 'function' ||
    typeof engine.categorizeTransaction !== 'function'
  ) {
    return uncategorized();
  }
  let compiled;
  try {
    compiled = engine.compileRules(db);
  } catch {
    return uncategorized();
  }
  return inserts.map((txn) => {
    try {
      const res = engine.categorizeTransaction(compiled, {
        date: txn.date,
        amountMinor: txn.amountMinor,
        payee: txn.payee,
        description: txn.description,
      });
      if (!res || res.categoryId == null) return null;
      const source = res.source === 'learned' ? 'learned' : 'rule';
      return {
        categoryId: Number(res.categoryId),
        ruleId: res.ruleId != null ? Number(res.ruleId) : null,
        source,
      };
    } catch {
      return null;
    }
  });
}

function pickProfileField(profile, camel, snake) {
  if (!profile) return undefined;
  if (profile[camel] !== undefined && profile[camel] !== null) return profile[camel];
  if (snake != null && profile[snake] !== undefined && profile[snake] !== null) return profile[snake];
  return undefined;
}

function maybeParseJson(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function resolveSettings(db, opts = {}) {
  let profile = opts.profile;
  if (!profile && opts.profileId != null) {
    profile = getProfile(db, opts.profileId);
    if (!profile) throw new ImportError('PROFILE_NOT_FOUND', `No import profile with id ${opts.profileId}`);
  }
  const o = opts.overrides ?? {};
  const skipPatterns = maybeParseJson(o.skipPatterns ?? pickProfileField(profile, 'skipPatterns')) ?? [];
  if (!Array.isArray(skipPatterns)) throw new ImportError('BAD_SKIP_PATTERNS', 'skipPatterns must be an array of strings');
  return {
    profile,
    profileId: opts.profileId ?? (profile ? profile.id : undefined),
    delimiter: o.delimiter ?? pickProfileField(profile, 'delimiter'),
    headerRow: o.headerRow ?? pickProfileField(profile, 'headerRow', 'header_row'),
    dateFormat: o.dateFormat ?? opts.dateFormat ?? pickProfileField(profile, 'dateFormat', 'date_format'),
    columnMap: maybeParseJson(o.columnMap ?? pickProfileField(profile, 'columnMap')),
    amountMode: o.amountMode ?? pickProfileField(profile, 'amountMode'),
    skipPatterns,
    filename: opts.filename ?? null,
  };
}

function normalizeColumnMap(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ImportError('BAD_COLUMN_MAP', 'columnMap must be an object mapping field -> column index');
  }
  const map = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!COLUMN_FIELDS.includes(k)) {
      throw new ImportError('BAD_COLUMN_MAP', `unknown columnMap field '${k}'`, { field: k });
    }
    if (!Number.isInteger(v) || v < 0) {
      throw new ImportError('BAD_COLUMN_MAP', `columnMap.${k} must be a non-negative integer`, { field: k, value: v });
    }
    map[k] = v;
  }
  return map;
}

function normalizeAmountMode(mode) {
  if (mode == null) return 'signed';
  if (!AMOUNT_MODES.includes(mode)) {
    throw new ImportError('BAD_AMOUNT_MODE', `amountMode must be one of ${JSON.stringify(AMOUNT_MODES)}`, {
      amountMode: mode,
    });
  }
  return mode;
}

function isHeaderish(row) {
  if (!Array.isArray(row)) return false;
  const filled = row.filter((c) => String(c ?? '').trim() !== '');
  if (filled.length < 2) return false;
  const lettered = filled.filter((c) => /[A-Za-z]/.test(String(c))).length;
  return lettered / filled.length > 0.5;
}

function findHeaderRow(rows) {
  const detected = detectHeaderRow(rows);
  if (isHeaderish(rows[detected])) return detected;
  for (let i = 0; i < rows.length; i++) {
    if (isHeaderish(rows[i])) return i;
  }
  return detected;
}

function analyzeText(text, settings) {
  const delim = settings.delimiter ?? detectDelimiter(text);
  if (typeof delim !== 'string' || delim.length !== 1) {
    throw new ImportError('BAD_DELIMITER', `invalid delimiter ${JSON.stringify(delim)}`);
  }
  const { rows } = parseCsv(text, { delimiter: delim });

  let headerRowIndex = settings.headerRow ?? findHeaderRow(rows);
  if (!Number.isInteger(headerRowIndex) || headerRowIndex < 0) headerRowIndex = findHeaderRow(rows);
  const headerLabels = (rows[headerRowIndex] ?? []).map((c) => String(c ?? '').trim());

  const skipRes = settings.skipPatterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch (err) {
      throw new ImportError('INVALID_SKIP_PATTERN', `invalid skip pattern ${JSON.stringify(p)}: ${err.message}`, {
        pattern: p,
      });
    }
  });

  const dataRows = [];
  const summaryRowsSkipped = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const cells = rows[i].map((c) => String(c ?? ''));
    const lineText = cells.join(delim);
    if (looksLikeSummaryRow(cells) || skipRes.some((re) => re.test(lineText))) {
      summaryRowsSkipped.push(i);
      continue;
    }
    dataRows.push({ rowIndex: i, cells });
  }

  return { delimiter: delim, rows, headerRowIndex, headerLabels, dataRows, summaryRowsSkipped };
}

function collectColumns(dataRows, idxs, limit = SAMPLE_LIMIT) {
  const vals = [];
  for (const { cells } of dataRows.slice(0, limit)) {
    for (const i of idxs) {
      if (i == null) continue;
      const v = String(cells[i] ?? '').trim();
      if (v !== '') vals.push(v);
    }
  }
  return vals;
}

function parsesAsAmount(v) {
  for (const hint of ['dot', 'comma', null]) {
    try {
      parseAmountToMinor(v, hint);
      return true;
    } catch {
      // try next hint
    }
  }
  return false;
}

function guessColumns(headerLabels, dataRows) {
  const sample = dataRows.slice(0, SAMPLE_LIMIT);
  const width = sample.reduce((w, r) => Math.max(w, r.cells.length), 0);

  const cols = [];
  for (let c = 0; c < width; c++) cols[c] = collectColumns(sample, [c], sample.length);

  let dateColumnIdx = -1;
  let dateBestFrac = 0;
  for (let c = 0; c < width; c++) {
    const vals = cols[c];
    if (vals.length === 0) continue;
    for (const fmt of DATE_FORMATS) {
      let ok = 0;
      for (const v of vals) {
        try {
          parseDateWithFormat(v, fmt);
          ok += 1;
        } catch {
          // not a date under this format
        }
      }
      const frac = ok / vals.length;
      if (frac >= 0.8 && frac > dateBestFrac) {
        dateBestFrac = frac;
        dateColumnIdx = c;
      }
    }
  }

  const numericCols = [];
  for (let c = 0; c < width; c++) {
    if (c === dateColumnIdx) continue;
    const vals = cols[c];
    if (vals.length === 0) continue;
    let ok = 0;
    for (const v of vals) if (parsesAsAmount(v)) ok += 1;
    if (ok / vals.length >= 0.5) numericCols.push(c);
  }

  let amountColumnIdx = -1;
  for (const c of numericCols) {
    const label = String(headerLabels?.[c] ?? '').toLowerCase();
    if (/amount|amt/.test(label)) {
      amountColumnIdx = c;
      break;
    }
  }
  if (amountColumnIdx === -1 && numericCols.length > 0) amountColumnIdx = numericCols[0];

  const numericSet = new Set(numericCols);
  const stringyCols = [];
  for (let c = 0; c < width; c++) {
    if (c === dateColumnIdx || numericSet.has(c)) continue;
    const vals = cols[c];
    if (vals.length === 0) continue;
    const lettered = vals.filter((v) => /[A-Za-z]/.test(v)).length;
    if (lettered / vals.length >= 0.5) stringyCols.push(c);
  }

  const columnMap = {};
  if (dateColumnIdx >= 0) columnMap.date = dateColumnIdx;
  if (amountColumnIdx >= 0) columnMap.amount = amountColumnIdx;
  if (stringyCols.length > 0) columnMap.payee = stringyCols[0];
  if (stringyCols.length > 1) columnMap.description = stringyCols[1];

  let dateFormatCandidates = [];
  let dateAmbiguous = false;
  if (dateColumnIdx >= 0 && cols[dateColumnIdx].length > 0) {
    const det = detectDateFormat(cols[dateColumnIdx]);
    dateFormatCandidates = det.candidates;
    dateAmbiguous = det.ambiguous;
  }

  const hintSamples =
    amountColumnIdx >= 0 ? cols[amountColumnIdx] : numericCols.flatMap((c) => cols[c]);
  const amountFormatHint = detectAmountFormat(hintSamples.slice(0, SAMPLE_LIMIT));

  return {
    columnMap: dateColumnIdx >= 0 ? columnMap : null,
    dateColumnIdx,
    amountColumnIdx,
    dateFormatCandidates,
    dateAmbiguous,
    amountFormatHint,
  };
}

function amountSampleIndexes(columnMap, amountMode) {
  return amountMode === 'signed'
    ? [columnMap.amount]
    : [columnMap.debit, columnMap.credit];
}

function buildDrafts(dataRows, columnMap, amountMode, dateFormat, decimalHint) {
  const drafts = [];
  const errors = [];

  for (const { rowIndex, cells } of dataRows) {
    const cell = (idx) => (idx == null ? '' : String(cells[idx] ?? '').trim());

    const dateRaw = cell(columnMap.date);
    let date;
    try {
      date = parseDateWithFormat(dateRaw, dateFormat);
    } catch {
      errors.push({
        rowIndex,
        message: `unparsable date '${dateRaw}' for format '${dateFormat}'`,
        raw: dateRaw,
      });
      continue;
    }

    let amountMinor;
    if (amountMode === 'signed') {
      const amountRaw = cell(columnMap.amount);
      try {
        amountMinor = parseAmountToMinor(amountRaw, decimalHint);
      } catch {
        errors.push({
          rowIndex,
          message: `unparsable amount ${JSON.stringify(amountRaw)}`,
          raw: amountRaw,
        });
        continue;
      }
    } else {
      const debitRaw = cell(columnMap.debit);
      const creditRaw = cell(columnMap.credit);
      const hasDebit = debitRaw !== '';
      const hasCredit = creditRaw !== '';
      if (hasDebit && hasCredit) {
        errors.push({
          rowIndex,
          message: 'both debit and credit populated',
          raw: `${debitRaw}|${creditRaw}`,
        });
        continue;
      }
      if (!hasDebit && !hasCredit) {
        errors.push({ rowIndex, message: 'zero-amount row: debit and credit both empty', raw: '' });
        continue;
      }
      try {
        amountMinor = hasDebit
          ? -parseAmountToMinor(debitRaw, decimalHint)
          : parseAmountToMinor(creditRaw, decimalHint);
      } catch {
        const raw = hasDebit ? debitRaw : creditRaw;
        errors.push({ rowIndex, message: `unparsable amount ${JSON.stringify(raw)}`, raw });
        continue;
      }
    }

    drafts.push({
      rowIndex,
      date,
      payee: cell(columnMap.payee) || 'Unknown',
      description: cell(columnMap.description),
      amountMinor,
    });
  }

  return { drafts, errors };
}

function ambiguityExamples(vals) {
  const out = [];
  for (const v of vals) {
    let a;
    let b;
    try {
      a = parseDateWithFormat(v, 'dmy');
      b = parseDateWithFormat(v, 'mdy');
    } catch {
      continue;
    }
    if (a !== b) out.push(v);
    if (out.length >= 5) break;
  }
  return out;
}

function sampleOf(cells, columnMap, amountMode) {
  const get = (i) => (i == null ? '' : String(cells[i] ?? '').trim());
  const row = {
    dateRaw: get(columnMap?.date),
    payee: get(columnMap?.payee) || 'Unknown',
    description: get(columnMap?.description),
  };
  if (amountMode === 'signed') {
    row.amountRaw = get(columnMap?.amount);
  } else {
    row.debitRaw = get(columnMap?.debit);
    row.creditRaw = get(columnMap?.credit);
  }
  return row;
}

function buildDetails(planSkipped, drafts, errors, summaryRowsSkipped) {
  return {
    skipped: planSkipped.map((s) => ({
      rowIndex: drafts[s.rowIndex] ? drafts[s.rowIndex].rowIndex : s.rowIndex,
      reason: s.reason,
      fingerprint: s.fingerprint,
    })),
    errors,
    summaryRowsSkipped,
  };
}

export function previewImport(db, buffer, opts = {}) {
  const settings = resolveSettings(db, opts);
  const { text, encoding } = decodeBuffer(buffer);
  const analysis = analyzeText(text, settings);

  const guess =
    analysis.dataRows.length > 0 ? guessColumns(analysis.headerLabels, analysis.dataRows) : null;

  const columnMap = normalizeColumnMap(settings.columnMap) ?? guess?.columnMap ?? null;
  const amountMode = normalizeAmountMode(settings.amountMode);

  let dateFormatCandidates = guess?.dateFormatCandidates ?? [];
  let dateAmbiguous = guess?.dateAmbiguous ?? false;
  let amountFormatHint = guess?.amountFormatHint ?? { decimalHint: null, ambiguous: true };

  if (columnMap && columnMap.date != null && analysis.dataRows.length > 0) {
    const dateVals = collectColumns(analysis.dataRows, [columnMap.date]);
    if (dateVals.length > 0) {
      const det = detectDateFormat(dateVals);
      dateFormatCandidates = det.candidates;
      dateAmbiguous = det.ambiguous;
    }
    amountFormatHint = detectAmountFormat(
      collectColumns(analysis.dataRows, amountSampleIndexes(columnMap, amountMode)),
    );
  }

  const chosenFormat = settings.dateFormat ?? dateFormatCandidates[0] ?? null;

  let errors = [];
  if (
    chosenFormat &&
    columnMap &&
    columnMap.date != null &&
    (columnMap.amount != null || columnMap.debit != null)
  ) {
    const built = buildDrafts(
      analysis.dataRows,
      columnMap,
      amountMode,
      chosenFormat,
      amountFormatHint.decimalHint,
    );
    errors = built.errors.map(({ rowIndex, message }) => ({ rowIndex, message }));
  }

  const sampleRows = analysis.dataRows
    .slice(0, SAMPLE_ROW_COUNT)
    .map((r) => sampleOf(r.cells, columnMap, amountMode));

  const accounts = db.prepare('SELECT name FROM accounts ORDER BY name').all().map((r) => r.name);

  return {
    encoding,
    delimiter: analysis.delimiter,
    headerRowIndex: analysis.headerRowIndex,
    headerLabels: analysis.headerLabels,
    rowCount: analysis.dataRows.length,
    columnMapGuess: guess?.columnMap ?? null,
    dateFormatCandidates,
    dateAmbiguous,
    amountFormatHint,
    accounts,
    sampleRows,
    errors,
  };
}

export function commitImport(db, buffer, opts = {}) {
  const settings = resolveSettings(db, opts);
  const { text, encoding } = decodeBuffer(buffer);
  const analysis = analyzeText(text, settings);

  if (analysis.rows.length === 0) {
    throw new ImportError('EMPTY_FILE', 'no rows found in file');
  }
  if (analysis.headerLabels.length === 0) {
    throw new ImportError(
      'NO_HEADER',
      `no header row at index ${analysis.headerRowIndex}`,
      { headerRowIndex: analysis.headerRowIndex },
    );
  }

  const guess =
    analysis.dataRows.length > 0 ? guessColumns(analysis.headerLabels, analysis.dataRows) : null;
  const columnMap = normalizeColumnMap(settings.columnMap) ?? guess?.columnMap ?? null;

  if (!columnMap || columnMap.date == null) {
    throw new ImportError('NO_DATE_COLUMN', 'no date column identifiable', {
      headerLabels: analysis.headerLabels,
    });
  }
  if (columnMap.amount == null && columnMap.debit == null) {
    throw new ImportError('MISSING_COLUMNS', "columnMap requires an 'amount' or 'debit' column", {
      columnMap,
    });
  }

  const amountMode = normalizeAmountMode(settings.amountMode);
  if (amountMode === 'signed' && columnMap.amount == null) {
    throw new ImportError("MISSING_COLUMNS", "amountMode 'signed' requires an 'amount' column", {
      columnMap,
    });
  }
  if (amountMode !== 'signed' && columnMap.debit == null) {
    throw new ImportError('MISSING_COLUMNS', `amountMode '${amountMode}' requires a 'debit' column`, {
      columnMap,
    });
  }

  const dateVals = collectColumns(analysis.dataRows, [columnMap.date]);
  if (dateVals.length === 0) {
    throw new ImportError('DATE_COLUMN_UNPARSEABLE', 'date column contains no values', {
      columnIndex: columnMap.date,
    });
  }
  const det = detectDateFormat(dateVals);
  if (det.candidates.length === 0) {
    throw new ImportError('DATE_COLUMN_UNPARSEABLE', 'no known date format fits the sampled date values', {
      samples: dateVals.slice(0, 5),
    });
  }

  const explicitFormat = settings.dateFormat;
  if (explicitFormat != null && !DATE_FORMATS.includes(explicitFormat)) {
    throw new ImportError('BAD_DATE_FORMAT', `dateFormat must be one of ${JSON.stringify(DATE_FORMATS)}`, {
      dateFormat: explicitFormat,
    });
  }
  if (det.ambiguous && explicitFormat == null) {
    const examples = ambiguityExamples(dateVals);
    const shown = examples.length > 0 ? examples.join(', ') : dateVals.slice(0, 3).join(', ');
    throw new ImportError(
      'AMBIGUOUS_DATES',
      `ambiguous dates (${shown}) fit both DD/MM/YYYY and MM/DD/YYYY — pass an explicit dateFormat ('dmy' | 'mdy' | 'ymd')`,
      { examples, candidates: det.candidates },
    );
  }
  const dateFormat = explicitFormat ?? det.candidates[0];

  const hint = detectAmountFormat(collectColumns(analysis.dataRows, amountSampleIndexes(columnMap, amountMode)));
  const { drafts, errors } = buildDrafts(analysis.dataRows, columnMap, amountMode, dateFormat, hint.decimalHint);

  const accountName = opts.accountName ?? opts.overrides?.accountName ?? null;
  const accountId = opts.accountId;
  if (accountId == null && !accountName) {
    throw new ImportError('NO_ACCOUNT', 'provide accountId or accountName');
  }

  let existingAccountId = null;
  if (accountId != null) {
    if (!Number.isInteger(accountId)) {
      throw new ImportError('BAD_ACCOUNT_ID', 'accountId must be an integer', { accountId });
    }
    const acc = db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId);
    if (!acc) throw new ImportError('ACCOUNT_NOT_FOUND', `no account with id ${accountId}`);
    existingAccountId = Number(acc.id);
  } else {
    const acc = db.prepare('SELECT id FROM accounts WHERE name = ?').get(accountName);
    if (acc) existingAccountId = Number(acc.id);
  }

  if (opts.dryRun === true) {
    const plan =
      existingAccountId != null
        ? planImport(db, existingAccountId, drafts)
        : { inserts: drafts.map((d, i) => ({ ...d, fingerprint: `dry-run-${i}` })), skipped: [] };
    return {
      fileId: null,
      importedCount: plan.inserts.length,
      skippedCount: plan.skipped.length,
      errorCount: errors.length,
      rowCount: analysis.dataRows.length,
      details: buildDetails(plan.skipped, drafts, errors, analysis.summaryRowsSkipped),
      profileSaved: null,
    };
  }

  db.exec('BEGIN');
  try {
    let finalAccountId = existingAccountId;
    if (finalAccountId == null) {
      const res = db.prepare('INSERT INTO accounts (name) VALUES (?)').run(accountName);
      finalAccountId = Number(res.lastInsertRowid);
    }

    const plan = planImport(db, finalAccountId, drafts);
    const cats = autoCategorize(db, plan.inserts);

    const insTxn = db.prepare(
      `INSERT INTO transactions
         (account_id, date, payee, description, amount_minor,
          category_id, category_source, applied_rule_id, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    plan.inserts.forEach((row, i) => {
      const cat = cats[i];
      insTxn.run(
        finalAccountId,
        row.date,
        row.payee,
        row.description,
        row.amountMinor,
        cat?.categoryId ?? null,
        cat?.source ?? null,
        cat?.ruleId ?? null,
        row.fingerprint,
      );
    });

    let savedProfileName = null;
    let ledgerProfileId = settings.profileId ?? null;
    if (opts.profileName != null) {
      if (typeof opts.profileName !== 'string' || opts.profileName.trim() === '') {
        throw new ImportError('BAD_PROFILE_NAME', 'profileName must be a non-empty string');
      }
      const config = {
        name: opts.profileName,
        delimiter: analysis.delimiter,
        encoding,
        headerRow: analysis.headerRowIndex,
        dateFormat,
        columnMap,
        amountMode,
        skipPatterns: settings.skipPatterns,
      };
      let pid = opts.profileId ?? null;
      if (pid != null) {
        const updated = updateProfile(db, pid, config);
        if (!updated) throw new ImportError('PROFILE_NOT_FOUND', `No import profile with id ${pid}`);
        pid = updated.id;
      } else {
        const byName = db.prepare('SELECT id FROM profiles WHERE name = ?').get(opts.profileName);
        pid = byName ? updateProfile(db, Number(byName.id), config).id : saveProfile(db, config);
      }
      savedProfileName = opts.profileName;
      ledgerProfileId = pid;
    }

    const details = buildDetails(plan.skipped, drafts, errors, analysis.summaryRowsSkipped);
    const res = db
      .prepare(
        `INSERT INTO import_files (filename, profile_id, row_count, imported_count, skipped_count, error_count, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        settings.filename ?? 'import.csv',
        ledgerProfileId,
        analysis.dataRows.length,
        plan.inserts.length,
        plan.skipped.length,
        errors.length,
        JSON.stringify(details),
      );

    db.exec('COMMIT');

    return {
      fileId: Number(res.lastInsertRowid),
      importedCount: plan.inserts.length,
      skippedCount: plan.skipped.length,
      errorCount: errors.length,
      rowCount: analysis.dataRows.length,
      details,
      profileSaved: savedProfileName,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // already rolled back / no active transaction
    }
    throw err;
  }
}

export function importProgressChunks(totalRows, chunkSize = 500) {
  if (!Number.isInteger(totalRows) || totalRows < 0) {
    throw new TypeError(`totalRows must be a non-negative integer, got ${JSON.stringify(totalRows)}`);
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError(`chunkSize must be a positive integer, got ${JSON.stringify(chunkSize)}`);
  }
  return Math.ceil(totalRows / chunkSize);
}
