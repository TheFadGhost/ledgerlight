import {
  api,
  fmtMoney,
  fmtDate,
  el,
  toast,
  announce,
} from '../lib.js';
import { navigate } from '../app.js';

ensureStyles();

const STEP_DEFS = [
  { key: 'source', label: 'Source' },
  { key: 'map', label: 'Map' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];

const DELIM_OPTIONS = [
  { v: '', label: 'Auto-detect' },
  { v: ',', label: 'Comma ( , )' },
  { v: ';', label: 'Semicolon ( ; )' },
  { v: '\t', label: 'Tab' },
  { v: '|', label: 'Pipe ( | )' },
];
const DELIM_WORDS = { ',': 'comma ( , )', ';': 'semicolon ( ; )', '\t': 'tab', '|': 'pipe ( | )' };
const DATE_LABELS = { dmy: 'DD/MM/YYYY', mdy: 'MM/DD/YYYY', ymd: 'YYYY-MM-DD' };
const COLUMN_FIELDS = ['date', 'amount', 'debit', 'credit', 'payee', 'description'];

export async function render(view) {
  const st = freshState();
  const [profiles, accounts] = await Promise.all([
    api('/profiles').catch(() => []),
    api('/accounts').catch(() => []),
  ]);
  st.profiles = Array.isArray(profiles) ? profiles : [];
  st.accounts = Array.isArray(accounts) ? accounts : [];

  const page = el('div.imp-page', {},
    el('div.page-head', {},
      el('h1', {}, 'Import'),
      el('span.page-sub', {}, 'Bring a bank CSV export into your ledger')),
    el('div.imp-stepper'),
    el('div.imp-body'),
  );
  view.innerHTML = '';
  view.append(page);
  st.refs.stepper = page.querySelector('.imp-stepper');
  st.refs.body = page.querySelector('.imp-body');
  announce('Import wizard ready');
  draw(st);
}

function ensureStyles() {
  if (document.querySelector('link[data-pages-css="import"]')) return;
  document.head.append(el('link', {
    rel: 'stylesheet',
    href: '/css/pages.css',
    'data-pages-css': 'import',
  }));
}

function freshState() {
  return {
    step: 'source',
    content: null,
    filename: null,
    preview: null,
    profileId: null,
    mappingDirty: false,
    mapping: blankMapping(),
    profiles: [],
    accounts: [],
    accountChoice: null,
    report: null,
    commitError: null,
    refs: {},
  };
}

function blankMapping() {
  return {
    headerRow: 0,
    delimiter: '',
    dateFormat: null,
    amountMode: 'signed',
    columnMap: {},
    skipPatterns: '',
  };
}

function activeProfile(st) {
  return st.profiles.find((p) => p.id === st.profileId) ?? null;
}

function modeWants(mode, field) {
  if (field === 'date' || field === 'payee' || field === 'description') return true;
  if (mode === 'signed') return field === 'amount';
  if (mode === 'split_dc') return field === 'debit' || field === 'credit';
  return false;
}

function numericColumnMap(m) {
  const cm = {};
  for (const f of COLUMN_FIELDS) {
    const v = m.columnMap[f];
    if (v != null && v !== '' && modeWants(m.amountMode, f)) cm[f] = Number(v);
  }
  return cm;
}

function buildOverrides(m) {
  const overrides = { headerRow: Number(m.headerRow) };
  if (m.delimiter !== '') overrides.delimiter = m.delimiter;
  overrides.columnMap = numericColumnMap(m);
  overrides.amountMode = m.amountMode;
  const pats = parseSkipPatterns(m.skipPatterns);
  if (pats.length > 0) overrides.skipPatterns = pats;
  return overrides;
}

function previewBody(st) {
  const body = { content: st.content, overrides: buildOverrides(st.mapping) };
  if (st.mapping.dateFormat) body.dateFormat = st.mapping.dateFormat;
  const prof = activeProfile(st);
  if (prof && !st.mappingDirty) body.profileId = prof.id;
  return body;
}

function parseSkipPatterns(text) {
  return String(text ?? '').split('\n').map((s) => s.trim()).filter((s) => s !== '');
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function parseRawDate(raw, fmt) {
  const s = String(raw ?? '').trim();
  const parts = s.split(/[-/. ]+/);
  if (parts.length !== 3 || parts.some((p) => !/^\d{1,4}$/.test(p))) return null;
  let y;
  let m;
  let d;
  if (fmt === 'ymd') [y, m, d] = parts;
  else if (fmt === 'dmy') [d, m, y] = parts;
  else if (fmt === 'mdy') [m, d, y] = parts;
  else return null;
  if (y.length === 2) y = +y <= 68 ? `20${y}` : `19${y}`;
  const Y = +y;
  const M = +m;
  const D = +d;
  if (M < 1 || M > 12 || D < 1 || D > daysInMonth(Y, M)) return null;
  return `${String(Y).padStart(4, '0')}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
}

function parseRawAmount(raw, hint) {
  if (raw == null) return null;
  let s = String(raw).trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s\u00A0\u202F\u2009]/g, '');
  if (/[Cc][Rr]$/.test(s)) s = s.slice(0, -2);
  else if (/[Dd]$/.test(s)) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  s = s.replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D-]/g, '-');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/[$€£¥₹₩₽]/g, '').replace(/[A-Za-z]/g, '');
  if (s === '' || !/\d/.test(s) || !/^[\d.,'\u2019]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart;
  let fracPart = '';
  if (lastDot >= 0 && lastComma >= 0) {
    const decSep = lastDot > lastComma ? '.' : ',';
    const parts = s.split(decSep);
    if (parts.length !== 2) return null;
    [intPart, fracPart] = parts;
    const other = decSep === '.' ? ',' : '.';
    if (fracPart.includes(other)) return null;
    intPart = intPart.split(other).join('');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const grouped = parts.length >= 2 && parts.slice(1).every((p) => p.length === 3 && /^\d+$/.test(p));
    const hinted = (sep === '.' && hint === 'dot') || (sep === ',' && hint === 'comma');
    if (grouped && !hinted) intPart = parts.join('');
    else if (parts.length === 2) [intPart, fracPart] = parts;
    else return null;
  } else {
    intPart = s.replace(/[.,'\u2019]/g, '');
  }
  if (!/^\d*$/.test(fracPart) || !/^\d+$/.test(intPart) || intPart.length > 13) return null;
  let cents;
  if (fracPart.length <= 2) cents = Number(fracPart.padEnd(2, '0'));
  else cents = Number(fracPart.slice(0, 2)) + (Number(fracPart[2]) >= 5 ? 1 : 0);
  const total = Number(intPart) * 100 + cents;
  if (!Number.isSafeInteger(total)) return null;
  return negative ? -total : total;
}

function draftFromSample(row, m, hint, fmt) {
  const iso = parseRawDate(row.dateRaw, fmt);
  let minor = null;
  if (m.amountMode === 'signed') {
    minor = parseRawAmount(row.amountRaw, hint);
  } else {
    const dr = parseRawAmount(row.debitRaw, hint);
    const cr = parseRawAmount(row.creditRaw, hint);
    if (dr != null && cr == null) minor = -dr;
    else if (cr != null && dr == null) minor = cr;
  }
  return { iso, minor };
}

function draw(st) {
  const idx = STEP_DEFS.findIndex((s) => s.key === st.step);
  st.refs.stepper.innerHTML = '';
  st.refs.stepper.append(stepper(idx));
  st.refs.body.innerHTML = '';
  const drawers = { source: drawSource, map: drawMap, review: drawReviewShell, done: drawDone };
  drawers[st.step](st, st.refs.body);
}

function stepper(activeIdx) {
  return el('ol.imp-steps', { 'aria-label': 'Import progress' },
    STEP_DEFS.flatMap((s, i) => {
      const cls = i === activeIdx
        ? 'imp-step is-current'
        : i < activeIdx ? 'imp-step is-done' : 'imp-step';
      const attrs = i === activeIdx ? { 'aria-current': 'step' } : {};
      const li = el('li.' + cls.split(' ').join('.'), attrs,
        el('span.imp-step-num', {}, String(i + 1)),
        el('span.imp-step-label', {}, s.label),
      );
      return i < STEP_DEFS.length - 1
        ? [li, el('li.imp-sep', { 'aria-hidden': 'true' }, '\u2192')]
        : [li];
    }),
  );
}

function go(st, step, message) {
  st.step = step;
  if (message) announce(message);
  draw(st);
}

function errorSlot() {
  return el('div.imp-error-slot', { role: 'alert' });
}

function isTransport(err) {
  return err instanceof TypeError && err.code === undefined;
}

function showError(slot, err) {
  slot.innerHTML = '';
  if (isTransport(err)) {
    slot.append(el('p.field-error', {}, `Network problem talking to the local server: ${err.message}`));
    toast(err.message || 'Request failed', 'error');
    announce('Request to the local server failed');
    return;
  }
  slot.append(el('p.field-error', {}, `${err.code ?? 'ERROR'}: ${err.message}`));
  if (err.code === 'AMBIGUOUS_DATES') {
    const examples = err.details?.examples;
    if (Array.isArray(examples) && examples.length > 0) {
      slot.append(el('p.muted', {}, `Ambiguous examples in this file: ${examples.join(', ')}`));
    }
  }
  announce(`${err.code ?? 'ERROR'}: ${err.message}`);
}

function clearError(slot) {
  slot.innerHTML = '';
}

function chip(text, kind) {
  return el('span.chip' + (kind ? ` chip-${kind}` : ''), {}, text);
}

function labeled(id, text, control) {
  return el('div', {}, el('label', { htmlFor: id }, text), control);
}

function selectControl(id, options, current, onchange) {
  return el('select', { id, onchange }, ...options.map((o) =>
    el('option', { value: o.v, selected: String(o.v) === String(current) }, o.label),
  ));
}

function radioGroup(name, options, current, onchange) {
  return el('div.imp-radios', {},
    options.map((o) => {
      const input = el('input', {
        type: 'radio',
        name,
        value: o.v,
        checked: String(o.v) === String(current),
        onchange: () => onchange(o.v),
      });
      input.id = `${name}-${String(o.v).replace(/[^a-z0-9]/gi, '')}`;
      return el('label', { htmlFor: input.id }, input, el('span', {}, o.label));
    }),
  );
}

function columnSelectOptions(preview, includeNone) {
  const labels = preview?.headerLabels ?? [];
  const opts = labels.map((lab, i) => ({
    v: String(i),
    label: `${i}: ${lab !== '' ? lab : '(no header)'}`,
  }));
  if (includeNone) opts.unshift({ v: '', label: '\u2014 none \u2014' });
  return opts;
}

function detectionChips(pv) {
  const hint = pv.amountFormatHint ?? {};
  const decText = hint.decimalHint === 'dot'
    ? 'dot (1,234.56)'
    : hint.decimalHint === 'comma'
      ? 'comma (1.234,56)'
      : 'unclear, applied automatically';
  return [
    chip(`Encoding: ${String(pv.encoding ?? '').toUpperCase()}`),
    chip(`Detected delimiter: ${DELIM_WORDS[pv.delimiter] ?? JSON.stringify(pv.delimiter)}`),
    chip(`Detected header row: index ${pv.headerRowIndex}`),
    chip(`Decimals: ${decText}`, hint.decimalHint ? undefined : 'warn'),
  ];
}

function ambiguityExamples(pv) {
  const seen = new Set();
  const out = [];
  for (const r of pv.sampleRows ?? []) {
    const raw = String(r.dateRaw ?? '').trim();
    if (raw === '' || seen.has(raw)) continue;
    seen.add(raw);
    const a = parseRawDate(raw, 'dmy');
    const b = parseRawDate(raw, 'mdy');
    if (a && b && a !== b) out.push([raw, a, b]);
    if (out.length >= 5) break;
  }
  return out;
}

function initMappingFromAnalysis(st) {
  const prof = activeProfile(st);
  const pv = st.preview;
  const m = blankMapping();
  m.headerRow = pv.headerRowIndex;
  m.delimiter = prof ? String(prof.delimiter ?? '') : '';
  m.amountMode = prof?.amountMode === 'split_dc' ? 'split_dc' : 'signed';
  const src = prof?.columnMap ?? pv.columnMapGuess ?? {};
  for (const f of COLUMN_FIELDS) {
    if (Number.isInteger(src[f]) && src[f] >= 0) m.columnMap[f] = String(src[f]);
  }
  if (prof) m.dateFormat = prof.dateFormat ?? pv.dateFormatCandidates[0] ?? null;
  else if (pv.dateAmbiguous) m.dateFormat = null;
  else m.dateFormat = pv.dateFormatCandidates[0] ?? null;
  m.skipPatterns = (prof?.skipPatterns ?? []).join('\n');
  st.mapping = m;
  st.mappingDirty = false;
}

function drawSource(st, box) {
  const slot = errorSlot();
  const analyzeBtn = el('button.btn.btn-primary', {
    type: 'button',
    disabled: String(st.content ?? '').trim() === '',
    onclick: () => runAnalyze(st, slot, analyzeBtn),
  }, 'Analyze');

  const fileNote = el('p.muted.imp-profile-hint', {},
    st.filename ? `Loaded file: ${st.filename}` : '');

  const pasteBox = el('textarea', {
    id: 'imp-paste',
    rows: 7,
    spellcheck: false,
    placeholder: 'Paste CSV rows here, including the header row',
    oninput: () => {
      st.content = pasteBox.value;
      if (pasteBox.value.trim() !== '') {
        st.filename = null;
        fileNote.textContent = '';
      }
      analyzeBtn.disabled = String(st.content ?? '').trim() === '';
    },
  });

  const fileInput = el('input', {
    id: 'imp-file',
    type: 'file',
    accept: '.csv,.txt,text/csv,text/plain',
    onchange: () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        st.content = String(reader.result ?? '');
        st.filename = file.name;
        pasteBox.value = '';
        fileNote.textContent = `Loaded file: ${file.name}`;
        analyzeBtn.disabled = false;
        announce(`Loaded ${file.name}, ready to analyze`);
      };
      reader.onerror = () => toast('Could not read that file', 'error');
      reader.readAsText(file);
    },
  });

  const profileSel = selectControl('imp-profile',
    [{ v: '', label: '\u2014 start blank \u2014' },
      ...st.profiles.map((p) => ({ v: String(p.id), label: p.name }))],
    st.profileId != null ? String(st.profileId) : '',
    (v) => chooseProfile(st, v),
  );

  const profilesBlock = st.profiles.length > 0
    ? labeled('imp-profile', 'Start from a saved format', profileSel)
    : el('p.muted.imp-profile-hint', {}, 'No saved formats yet - mappings you save appear here.');

  box.append(el('section.card', {},
    el('h2', {}, 'Choose a CSV source'),
    profilesBlock,
    el('fieldset.imp-fieldset.section-gap', {},
      el('legend', {}, 'CSV source'),
      el('div.imp-fields', {},
        labeled('imp-file', 'Choose a file (.csv or .txt)', fileInput),
        fileNote,
        labeled('imp-paste', 'Or paste CSV text', pasteBox),
      )),
    el('div.imp-actions', {},
      el('span.muted', {}, 'Step 1 of 4'),
      el('span.imp-spacer'),
      analyzeBtn,
      slot,
    ),
  ));
}

function chooseProfile(st, v) {
  if (v === '') {
    st.profileId = null;
    if (st.preview) initMappingFromAnalysis(st);
    announce('Blank mapping selected');
    if (st.preview) draw(st);
    return;
  }
  const prof = st.profiles.find((p) => String(p.id) === v);
  if (!prof) return;
  st.profileId = Number(prof.id);
  if (st.preview) {
    initMappingFromAnalysis(st);
    go(st, 'map', `Applied saved format ${prof.name}. Step 2 of 4: map columns`);
  } else {
    announce(`Saved format ${prof.name} selected`);
    toast(`"${prof.name}" will be applied when you Analyze`, 'info');
  }
}

async function runAnalyze(st, slot, btn) {
  clearError(slot);
  btn.disabled = true;
  try {
    const body = { content: st.content };
    const prof = activeProfile(st);
    if (prof && !st.mappingDirty) body.profileId = prof.id;
    const res = await api('/import/preview', { method: 'POST', body });
    st.preview = res;
    initMappingFromAnalysis(st);
    go(st, 'map', `Analysed ${res.rowCount} data rows. Step 2 of 4: map columns`);
  } catch (err) {
    showError(slot, err);
    btn.disabled = false;
  }
}

function setColumn(m, field, value) {
  if (value === '') delete m.columnMap[field];
  else m.columnMap[field] = value;
}

function mappingProblems(st) {
  const m = st.mapping;
  if (m.columnMap.date == null || m.columnMap.date === '') return 'Choose a date column.';
  if (m.amountMode === 'signed' && (m.columnMap.amount == null || m.columnMap.amount === '')) {
    return 'Choose the Amount column, or switch amount mode.';
  }
  if (m.amountMode !== 'signed' && (m.columnMap.debit == null || m.columnMap.debit === '')) {
    return 'Choose the Debit column for split debit/credit mode.';
  }
  if (st.preview?.dateAmbiguous && !m.dateFormat) {
    return 'These dates are ambiguous. Choose DD/MM or MM/DD explicitly before continuing.';
  }
  for (const line of parseSkipPatterns(m.skipPatterns)) {
    try {
      new RegExp(line, 'i');
    } catch {
      return `Invalid skip pattern: ${line}`;
    }
  }
  return null;
}

async function refreshAnalysis(st) {
  try {
    const overrides = {};
    overrides.headerRow = Number(st.mapping.headerRow);
    if (st.mapping.delimiter !== '') overrides.delimiter = st.mapping.delimiter;
    const res = await api('/import/preview', {
      method: 'POST',
      body: { content: st.content, overrides },
    });
    st.preview = res;
    st.mapping.headerRow = res.headerRowIndex;
    const width = (res.headerLabels ?? []).length;
    for (const f of Object.keys(st.mapping.columnMap)) {
      const v = Number(st.mapping.columnMap[f]);
      if (width > 0 && (!Number.isInteger(v) || v < 0 || v >= width)) {
        delete st.mapping.columnMap[f];
      }
    }
    const g = res.columnMapGuess ?? {};
    for (const f of COLUMN_FIELDS) {
      const cur = st.mapping.columnMap[f];
      if ((cur == null || cur === '') && Number.isInteger(g[f]) && g[f] >= 0
        && (width === 0 || g[f] < width)) {
        st.mapping.columnMap[f] = String(g[f]);
      }
    }
    if (st.mapping.dateFormat != null
      && !(res.dateFormatCandidates ?? []).includes(st.mapping.dateFormat)) {
      st.mapping.dateFormat = res.dateAmbiguous
        ? null
        : res.dateFormatCandidates[0] ?? null;
    }
  } catch (err) {
    toast(err.message || 'Could not re-analyze with these settings', 'error');
  }
  draw(st);
}

function compareTable(pv) {
  const rows = ambiguityExamples(pv);
  if (rows.length === 0) {
    return el('p.muted', {}, 'No sample dates differ between DD/MM and MM/DD readings.');
  }
  return el('table.imp-datecmp', {},
    el('caption', {}, 'The same values read both ways'),
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col' }, 'Raw value'),
      el('th', { scope: 'col' }, 'Read as DD/MM/YYYY'),
      el('th', { scope: 'col' }, 'Read as MM/DD/YYYY'))),
    el('tbody', {}, rows.map(([raw, d, md]) => el('tr', {},
      el('td', { class: 'num imp-mono' }, raw),
      el('td', {}, fmtDate(d)),
      el('td', {}, fmtDate(md))))),
  );
}

function dateFormatSection(st) {
  const pv = st.preview;
  const m = st.mapping;
  const ambiguous = !!pv.dateAmbiguous;
  const kids = [];
  if (ambiguous) kids.push(el('div', {}, chip('Ambiguous dates - choose explicitly', 'warn')));
  const keys = ambiguous ? ['dmy', 'mdy'] : ['dmy', 'mdy', 'ymd'];
  kids.push(radioGroup('imp-date-format',
    keys.map((f) => ({ v: f, label: DATE_LABELS[f] })),
    m.dateFormat,
    (v) => {
      m.dateFormat = v;
      st.mappingDirty = true;
    }));
  if (ambiguous) kids.push(compareTable(pv));
  else if (!m.dateFormat && (pv.dateFormatCandidates ?? []).length === 0) {
    kids.push(el('p.muted', {}, 'No date format detected yet - pick the one matching the raw values.'));
  }
  return el('fieldset.imp-fieldset', {}, el('legend', {}, 'Date format'), ...kids);
}

function modeSelects(st) {
  const pv = st.preview;
  const m = st.mapping;
  if (m.amountMode === 'signed') {
    return labeled('imp-col-amount', 'Amount column (signed)',
      selectControl('imp-col-amount', columnSelectOptions(pv, false), m.columnMap.amount ?? '',
        (v) => {
          setColumn(m, 'amount', v);
          st.mappingDirty = true;
        }));
  }
  return [
    labeled('imp-col-debit', 'Debit column (money out)',
      selectControl('imp-col-debit', columnSelectOptions(pv, false), m.columnMap.debit ?? '',
        (v) => {
          setColumn(m, 'debit', v);
          st.mappingDirty = true;
        })),
    labeled('imp-col-credit', 'Credit column (money in)',
      selectControl('imp-col-credit', columnSelectOptions(pv, true), m.columnMap.credit ?? '',
        (v) => {
          setColumn(m, 'credit', v);
          st.mappingDirty = true;
        })),
  ];
}

function drawMap(st, box) {
  const m = st.mapping;
  const pv = st.preview;
  const slot = errorSlot();

  const headSel = selectControl('imp-header-row',
    Array.from({ length: 6 }, (_, i) => ({ v: String(i), label: `Row ${i}` })),
    String(m.headerRow),
    (v) => {
      m.headerRow = Number(v);
      st.mappingDirty = true;
      refreshAnalysis(st);
    });

  const delimSel = selectControl('imp-delimiter', DELIM_OPTIONS, m.delimiter,
    (v) => {
      m.delimiter = v;
      st.mappingDirty = true;
      refreshAnalysis(st);
    });

  const dateSel = selectControl('imp-col-date', columnSelectOptions(pv, false), m.columnMap.date ?? '',
    (v) => {
      setColumn(m, 'date', v);
      st.mappingDirty = true;
    });

  const modeGroup = el('fieldset.imp-fieldset', {},
    el('legend', {}, 'Amount columns'),
    radioGroup('imp-amount-mode',
      [
        { v: 'signed', label: 'One signed Amount column' },
        { v: 'split_dc', label: 'Separate Debit / Credit columns' },
      ],
      m.amountMode,
      (v) => {
        m.amountMode = v;
        st.mappingDirty = true;
        draw(st);
        document.querySelector('input[name="imp-amount-mode"]')?.focus();
      }),
    el('div.imp-inline.section-gap', {}, modeSelects(st)),
  );

  const skipBox = el('textarea', {
    id: 'imp-skip',
    rows: 3,
    spellcheck: false,
    placeholder: '^Ending Balance$',
    oninput: () => {
      m.skipPatterns = skipBox.value;
      st.mappingDirty = true;
    },
  });
  skipBox.value = m.skipPatterns;

  const nameInput = el('input', { id: 'imp-profile-name', type: 'text', maxlength: '80' });
  const saveRow = el('div.imp-inline.section-gap', { hidden: true },
    labeled('imp-profile-name', 'Profile name', nameInput));
  const saveConfirm = el('button.btn.btn-primary.btn-sm', {
    type: 'button',
    onclick: () => saveProfileAs(st, slot, nameInput, saveConfirm, saveRow),
  }, 'Save profile');
  const saveCancel = el('button.btn.btn-ghost.btn-sm', {
    type: 'button',
    onclick: () => {
      saveRow.hidden = true;
      nameInput.value = '';
    },
  }, 'Cancel');
  saveRow.append(saveConfirm, saveCancel);

  const backBtn = el('button.btn.btn-ghost', {
    type: 'button',
    onclick: () => go(st, 'source', 'Back to source selection. Step 1 of 4'),
  }, 'Back');

  const saveBtn = el('button.btn', {
    type: 'button',
    onclick: () => {
      saveRow.hidden = !saveRow.hidden;
      if (!saveRow.hidden) nameInput.focus();
    },
  }, 'Save this mapping as profile');

  const previewBtn = el('button.btn.btn-primary', {
    type: 'button',
    onclick: () => gotoReview(st, slot, previewBtn),
  }, 'Preview parsed rows');

  box.append(el('section.card', {},
    el('h2', {}, 'Map columns'),
    el('div.imp-chiprow', {}, detectionChips(pv)),
    el('div.imp-fields', {},
      el('div.imp-inline', {},
        labeled('imp-header-row', 'Header row index', headSel),
        labeled('imp-delimiter', 'Delimiter', delimSel)),
      el('fieldset.imp-fieldset', {},
        el('legend', {}, 'Columns'),
        el('div.imp-inline', {},
          labeled('imp-col-date', 'Date column', dateSel))),
      modeGroup,
      dateFormatSection(st),
      el('div', {},
        labeled('imp-skip', 'Skip patterns (optional)', skipBox),
        el('p.muted', {}, 'One regular expression per line; matching rows are ignored.'))),
    el('div.imp-actions', {},
      backBtn,
      el('span.imp-spacer'),
      saveBtn,
      previewBtn),
    saveRow,
    slot,
  ));
}

async function saveProfileAs(st, slot, nameInput, btn, saveRow) {
  clearError(slot);
  const name = nameInput.value.trim();
  if (name === '') {
    slot.append(el('p.field-error', {}, 'Enter a name for this profile.'));
    return;
  }
  const problem = mappingProblems(st)
    ?? (!st.mapping.dateFormat
      ? 'Choose a date format before saving; saved formats must pin it down.'
      : null);
  if (problem) {
    slot.append(el('p.field-error', {}, problem));
    announce(problem);
    return;
  }
  btn.disabled = true;
  try {
    const id = await api('/profiles', {
      method: 'POST',
      body: {
        name,
        delimiter: st.mapping.delimiter === '' ? st.preview.delimiter : st.mapping.delimiter,
        encoding: st.preview.encoding ?? 'utf-8',
        headerRow: Number(st.mapping.headerRow),
        dateFormat: st.mapping.dateFormat,
        columnMap: numericColumnMap(st.mapping),
        amountMode: st.mapping.amountMode,
        skipPatterns: parseSkipPatterns(st.mapping.skipPatterns),
      },
    });
    st.profiles = await api('/profiles');
    st.profileId = Number(id);
    st.mappingDirty = false;
    saveRow.hidden = true;
    nameInput.value = '';
    toast(`Saved mapping as "${name}"`, 'success');
    announce(`Saved mapping as profile ${name}`);
  } catch (err) {
    showError(slot, err);
  }
  btn.disabled = false;
}

async function gotoReview(st, slot, btn) {
  clearError(slot);
  const problem = mappingProblems(st);
  if (problem) {
    slot.append(el('p.field-error', {}, problem));
    announce(problem);
    return;
  }
  btn.disabled = true;
  try {
    const res = await api('/import/preview', { method: 'POST', body: previewBody(st) });
    st.preview = res;
    go(st, 'review', `Preview ready: ${res.rowCount} data rows. Step 3 of 4: review`);
  } catch (err) {
    showError(slot, err);
    btn.disabled = false;
  }
}

function drawReviewShell(st, box) {
  box.append(el('section.card', { 'aria-busy': 'true' },
    el('h2', {}, 'Review'),
    el('p.muted', {}, 'Parsing all rows against your mapping...')));
  loadReview(st, box);
}

async function loadReview(st, box) {
  try {
    const res = await api('/import/preview', { method: 'POST', body: previewBody(st) });
    st.preview = res;
    box.innerHTML = '';
    box.append(reviewCard(st, res));
    announce(`Review ready: ${res.rowCount} data rows, ${(res.errors ?? []).length} problem rows`);
  } catch (err) {
    box.innerHTML = '';
    const slot = errorSlot();
    showError(slot, err);
    box.append(el('section.card', {},
      el('h2', {}, 'Review'),
      slot,
      el('div.imp-actions', {},
        el('button.btn', {
          type: 'button',
          onclick: () => go(st, 'map', 'Back to mapping. Step 2 of 4'),
        }, 'Back to mapping'))));
  }
}

function reviewRows(st, res) {
  const m = st.mapping;
  const fmt = m.dateFormat ?? (res.dateFormatCandidates ?? [])[0] ?? null;
  const hint = res.amountFormatHint?.decimalHint ?? null;
  return (res.sampleRows ?? []).slice(0, 10).map((r) => {
    const d = draftFromSample(r, m, hint, fmt);
    return el('tr', {},
      el('td', { class: 'num' }, String(r.rowIndex)),
      d.iso
        ? el('td', {}, fmtDate(d.iso))
        : el('td', {}, `${String(r.dateRaw ?? '')} (unparsed)`),
      el('td', {}, r.payee ?? ''),
      el('td', {}, r.description ?? ''),
      d.minor != null
        ? el('td', {
          class: `num${d.minor < 0 ? ' amount-neg' : ' amount-pos'}`,
        }, fmtMoney(d.minor))
        : el('td', { class: 'num muted' }, '(unparsed)'),
    );
  });
}

function accountSection(st) {
  if (!st.accountChoice) {
    st.accountChoice = st.accounts.length > 0
      ? { mode: 'existing', id: Number(st.accounts[0].id) }
      : { mode: 'new', name: '' };
  }
  const opts = st.accounts.map((a) => ({ v: String(a.id), label: `${a.name} (${a.type})` }));
  opts.push({ v: 'new', label: 'New account\u2026' });
  const current = st.accountChoice.mode === 'existing' ? String(st.accountChoice.id) : 'new';
  const sel = selectControl('imp-account', opts, current, (v) => {
    st.accountChoice = v === 'new'
      ? { mode: 'new', name: '' }
      : { mode: 'existing', id: Number(v) };
    draw(st);
    document.getElementById('imp-account')?.focus();
  });
  const parts = [labeled('imp-account', 'Destination account', sel)];
  if (current === 'new') {
    const nameIn = el('input', {
      id: 'imp-account-new',
      type: 'text',
      maxlength: '80',
      value: st.accountChoice.name ?? '',
      oninput: () => {
        st.accountChoice = { mode: 'new', name: nameIn.value };
      },
    });
    parts.push(labeled('imp-account-new', 'New account name', nameIn));
  }
  return el('fieldset.imp-fieldset', {},
    el('legend', {}, 'Destination account'),
    el('div.imp-inline', {}, ...parts));
}

function reviewCard(st, res) {
  const slot = errorSlot();
  const errCount = (res.errors ?? []).length;
  const importBtn = el('button.btn.btn-primary', {
    type: 'button',
    disabled: res.rowCount === 0,
    onclick: () => requestCommit(st, slot),
  }, `Import ${res.rowCount} rows`);
  return el('section.card', {},
    el('h2', {}, 'Step 3 of 4: Review'),
    el('div.imp-chiprow', {},
      chip(`${res.rowCount} data rows`),
      chip(`${errCount} problem rows`, errCount > 0 ? 'neg' : undefined)),
    el('table', {},
      el('caption', {},
        `Parsed preview: first ${(res.sampleRows ?? []).length} of ${res.rowCount} data rows`),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Row'),
        el('th', { scope: 'col' }, 'Date'),
        el('th', { scope: 'col' }, 'Payee'),
        el('th', { scope: 'col' }, 'Memo'),
        el('th', { scope: 'col', class: 'num' }, 'Amount'))),
      el('tbody', {}, reviewRows(st, res))),
    el('h3.section-gap', {}, 'Row problems'),
    errCount > 0
      ? el('ul.imp-errorlist', {}, (res.errors ?? []).map((e) =>
        el('li', {}, el('span.num', {}, `Row ${e.rowIndex}`), `: ${e.message}`)))
      : el('p.muted', {}, 'No row-level problems detected.'),
    el('div.section-gap', {}, accountSection(st)),
    el('div.imp-actions', {},
      el('button.btn.btn-ghost', {
        type: 'button',
        onclick: () => go(st, 'map', 'Back to mapping. Step 2 of 4'),
      }, 'Back to mapping'),
      el('span.imp-spacer'),
      importBtn,
      slot));
}

function requestCommit(st, slot) {
  clearError(slot);
  if (!st.accountChoice
    || (st.accountChoice.mode === 'new' && st.accountChoice.name.trim() === '')) {
    slot.append(el('p.field-error', {},
      'Choose an existing account or enter a new account name.'));
    announce('Choose a destination account first');
    return;
  }
  st.report = null;
  st.commitError = null;
  go(st, 'done', 'Importing. Step 4 of 4');
}

function drawDone(st, box) {
  if (st.commitError) {
    const slot = errorSlot();
    showError(slot, st.commitError);
    box.append(el('section.card', {},
      el('h2', {}, 'Import failed'),
      slot,
      el('div.imp-actions', {},
        el('button.btn.btn-ghost', {
          type: 'button',
          onclick: () => {
            st.commitError = null;
            go(st, 'review', 'Back to review. Step 3 of 4');
          },
        }, 'Back to mapping'),
        el('span.imp-spacer'),
        el('button.btn.btn-primary', {
          type: 'button',
          onclick: () => {
            st.commitError = null;
            st.report = null;
            draw(st);
          },
        }, 'Try again'))));
    return;
  }
  if (!st.report) {
    box.append(el('section.card', { 'aria-busy': 'true' },
      el('h2', {}, 'Importing'),
      el('p', { role: 'status' }, 'Importing... server is applying all rows in one transaction'),
      el('div.progress-track', { 'aria-hidden': 'true' }, el('div.imp-indet-fill')),
    ));
    performCommit(st);
    return;
  }
  box.append(reportCard(st));
}

async function performCommit(st) {
  const body = { content: st.content };
  if (st.mapping.dateFormat) body.dateFormat = st.mapping.dateFormat;
  if (st.accountChoice.mode === 'existing') body.accountId = st.accountChoice.id;
  else body.accountName = st.accountChoice.name.trim();
  const prof = activeProfile(st);
  if (prof && !st.mappingDirty) body.profileId = prof.id;
  try {
    const res = await api('/import/commit', { method: 'POST', body });
    st.report = res;
    announce(`Imported ${res.importedCount} rows, skipped ${res.skippedCount}`);
    draw(st);
  } catch (err) {
    st.commitError = err;
    draw(st);
  }
}

function statCell(labelText, value) {
  return el('div', {}, el('dt', {}, labelText), el('dd', { class: 'num' }, String(value)));
}

function skippedDetails(res) {
  const list = res.details?.skipped ?? [];
  if (list.length === 0) return el('p.muted', {}, 'No duplicate rows were skipped.');
  return el('details.imp-detail', {},
    el('summary', {},
      `${list.length} row${list.length === 1 ? '' : 's'} skipped as duplicates - show details`),
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Row'),
        el('th', { scope: 'col' }, 'Reason'),
        el('th', { scope: 'col' }, 'Fingerprint'))),
      el('tbody', {}, list.map((s) => el('tr', {},
        el('td', { class: 'num' }, String(s.rowIndex)),
        el('td', {}, s.reason ?? ''),
        el('td', { class: 'imp-mono' }, s.fingerprint ?? ''))))));
}

function errorDetails(res) {
  const list = res.details?.errors ?? [];
  if (list.length === 0) return el('p.muted', {}, 'No row errors.');
  return el('details.imp-detail', {},
    el('summary', {},
      `${list.length} row error${list.length === 1 ? '' : 's'} - show details`),
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Row'),
        el('th', { scope: 'col' }, 'Message'),
        el('th', { scope: 'col' }, 'Raw value'))),
      el('tbody', {}, list.map((e) => el('tr', {},
        el('td', { class: 'num' }, String(e.rowIndex)),
        el('td', {}, e.message ?? ''),
        el('td', { class: 'imp-mono' }, e.raw ?? ''))))));
}

function reportCard(st) {
  const r = st.report;
  const summarySkipped = (r.details?.summaryRowsSkipped ?? []).length;
  return el('section.card', {},
    el('h2', {}, 'Import complete'),
    el('dl.imp-stats', {},
      statCell('Imported', r.importedCount),
      statCell('Skipped (duplicates)', r.skippedCount),
      statCell('Row errors', r.errorCount),
      statCell('Summary rows ignored while parsing', summarySkipped),
      statCell('Data rows in file', r.rowCount)),
    r.profileSaved ? el('p', {}, chip(`Saved profile: ${r.profileSaved}`, 'pos')) : null,
    skippedDetails(r),
    errorDetails(r),
    el('div.imp-actions', {},
      el('button.btn', {
        type: 'button',
        onclick: () => resetForNewImport(st),
      }, 'Import another file'),
      el('span.imp-spacer'),
      el('button.btn.btn-primary', {
        type: 'button',
        onclick: () => navigate('/dashboard'),
      }, 'Go to dashboard')));
}

function resetForNewImport(st) {
  const refs = st.refs;
  const profiles = st.profiles;
  const accounts = st.accounts;
  Object.assign(st, freshState());
  st.refs = refs;
  st.profiles = profiles;
  st.accounts = accounts;
  announce('Ready for another import. Step 1 of 4');
  draw(st);
}
