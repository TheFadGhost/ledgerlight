import {
  api, fmtMoney, fmtDate, el, toast, announce, openDialog, confirmDialog,
} from '../lib.js';

const PAGE_SIZE = 100;
const MRU_KEY = 'ledgerlight.mruCategories';
const SERVER_SORTS = new Set(['date', 'payee', 'category', 'amount']);
const DEFAULT_DIR = { date: 'desc', amount: 'desc', payee: 'asc', category: 'asc', account: 'asc' };

let state = null;

export async function render(view) {
  ensureStyles();
  clearTimeout(state?.searchTimer);
  view.innerHTML = '';
  view.append(skeleton());

  let accounts;
  let categories;
  let meta;
  try {
    [accounts, categories, meta] = await Promise.all([
      api('/accounts'),
      api('/categories'),
      api('/meta'),
    ]);
  } catch (err) {
    view.innerHTML = '';
    view.append(errorPanel(err));
    return;
  }

  state = {
    accounts,
    categories,
    totalTxns: meta.counts.transactions,
    filters: filtersFromLocation(),
    sort: sortFromLocation(),
    offset: offsetFromLocation(),
    limit: PAGE_SIZE,
    selected: new Set(),
    mru: loadMru(),
    rowById: new Map(),
    seq: 0,
    searchTimer: null,
    lastFocusId: null,
  };

  if (!accounts.length) {
    view.innerHTML = '';
    view.append(noAccountsView());
    return;
  }

  await draw();
}

function ensureStyles() {
  if (document.querySelector('link[data-pages-css="transactions"]')) return;
  document.head.append(el('link', {
    rel: 'stylesheet',
    href: '/css/pages.css',
    'data-pages-css': 'transactions',
  }));
}

function skeleton() {
  const wrap = el('div.skeleton-wrap');
  for (let i = 0; i < 6; i += 1) wrap.append(el('div.skeleton-bar'));
  return wrap;
}

function errorPanel(err) {
  return el('div.error-panel', {}, `Could not load transactions: ${err.message}`);
}

// ---- money parsing (exact string math, no float drift) --------------------

export function parseMoneyToMinor(raw) {
  const s = String(raw ?? '').trim();
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const [, sign, whole, fracRaw = ''] = m;
  if (fracRaw.length > 2) return null;
  const frac = fracRaw.padEnd(2, '0');
  const abs = Number(BigInt(whole + frac));
  if (!Number.isSafeInteger(abs)) return null;
  return sign === '-' ? -abs : abs;
}

export function minorToDecimalText(minor) {
  if (!Number.isInteger(minor)) return '';
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(minor)).padStart(3, '0');
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

// ---- URL state -------------------------------------------------------------

function filtersFromLocation() {
  const p = new URLSearchParams(location.search);
  return {
    q: p.get('q') ?? '',
    accountId: p.get('accountId') ?? '',
    categoryId: p.get('categoryId') ?? '',
    uncategorized: p.get('uncategorized') === '1',
    from: /^\d{4}-\d{2}-\d{2}$/.test(p.get('from') ?? '') ? p.get('from') : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(p.get('to') ?? '') ? p.get('to') : '',
    min: intOrNull(p.get('min')),
    max: intOrNull(p.get('max')),
  };
}

function sortFromLocation() {
  const p = new URLSearchParams(location.search);
  const key = [...SERVER_SORTS, 'account'].includes(p.get('sort')) ? p.get('sort') : 'date';
  const dir = p.get('dir') === 'asc' ? 'asc' : p.get('dir') === 'desc' ? 'desc' : DEFAULT_DIR[key];
  return { key, dir };
}

function offsetFromLocation() {
  const n = Number(new URLSearchParams(location.search).get('offset'));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function intOrNull(v) {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function syncUrl({ replace }) {
  const p = new URLSearchParams();
  const f = state.filters;
  if (f.q) p.set('q', f.q);
  if (f.accountId) p.set('accountId', f.accountId);
  if (f.categoryId) p.set('categoryId', f.categoryId);
  if (f.uncategorized) p.set('uncategorized', '1');
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.min != null) p.set('min', String(f.min));
  if (f.max != null) p.set('max', String(f.max));
  if (state.sort.key !== 'date' || state.sort.dir !== DEFAULT_DIR.date) {
    p.set('sort', state.sort.key);
    p.set('dir', state.sort.dir);
  }
  if (state.offset > 0) p.set('offset', String(state.offset));
  const qs = p.toString();
  history[replace ? 'replaceState' : 'pushState'](null, '', `/transactions${qs ? `?${qs}` : ''}`);
}

async function fetchRows() {
  const f = state.filters;
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.accountId) p.set('accountId', f.accountId);
  if (f.uncategorized) {
    p.set('uncategorized', '1');
  } else if (f.categoryId) {
    p.set('categoryId', f.categoryId);
  }
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.min != null) p.set('min', String(f.min));
  if (f.max != null) p.set('max', String(f.max));
  if (SERVER_SORTS.has(state.sort.key)) {
    p.set('sort', state.sort.key);
    p.set('dir', state.sort.dir);
  }
  p.set('limit', String(state.limit));
  p.set('offset', String(state.offset));

  const res = await api(`/transactions?${p}`);
  if (state.sort.key === 'account') {
    const mul = state.sort.dir === 'asc' ? 1 : -1;
    res.rows = [...res.rows].sort((a, b) => {
      const cmp = a.accountName.localeCompare(b.accountName, undefined, { sensitivity: 'base' });
      return (cmp !== 0 ? cmp : a.id - b.id) * mul;
    });
  }
  return res;
}

async function draw() {
  clearTimeout(state.searchTimer);
  const seq = ++state.seq;
  let res;
  try {
    res = await fetchRows();
  } catch (err) {
    if (seq === state.seq) {
      document.getElementById('view').innerHTML = '';
      document.getElementById('view').append(errorPanel(err));
    }
    return null;
  }
  if (seq !== state.seq) return null;

  state.offset = res.total === 0 ? 0 : res.offset;
  state.rowById = new Map(res.rows.map((r) => [r.id, r]));

  const root = el('div.txn-page');
  root.append(pageHead());
  if (state.totalTxns === 0) {
    root.append(emptyNeverImported());
    const v = document.getElementById('view');
    v.innerHTML = '';
    v.append(root);
    return res;
  }
  root.append(filterBar());
  root.append(chipsRow());
  root.append(bulkBar());
  if (res.rows.length === 0) {
    root.append(emptyNoMatch());
  } else {
    root.append(tableView(res));
    root.append(pageBar(res));
  }
  root.addEventListener('keydown', onPageKeydown);

  const v = document.getElementById('view');
  const activeEl = document.activeElement;
  const keepSearchFocus = activeEl?.id === 'tf-q' && activeEl.tagName === 'INPUT';
  const caret = keepSearchFocus ? activeEl.selectionStart : null;
  v.innerHTML = '';
  v.append(root);
  if (keepSearchFocus) {
    const search = document.getElementById('tf-q');
    if (search) {
      search.focus();
      try { search.setSelectionRange(caret, caret); } catch { /* type=search quirks */ }
    }
  }
  return res;
}

// ---- page chrome -----------------------------------------------------------

function pageHead() {
  return el('div.page-head', {},
    el('div', {},
      el('h1', {}, 'Transactions'),
      el('span.page-sub', {}, 'Search, categorize, and split what came in and went out')),
    el('div.txn-head-actions', {},
      el('button.btn.btn-primary', { type: 'button', onclick: () => openManualEntry() }, 'Add cash transaction')),
  );
}

function noAccountsView() {
  return el('div.empty-state', {},
    el('h2', {}, 'Welcome to Ledgerlight'),
    el('p', {}, 'Import a bank CSV export to start tracking transactions, categorize spending, and see where each month goes.'),
    el('a.btn.btn-primary', { href: '/import', 'data-nav': 'import' }, 'Import CSV'),
  );
}

function emptyNeverImported() {
  return el('div.empty-state', {},
    el('h2', {}, 'No transactions yet'),
    el('p', {}, 'Import a CSV export from your bank, or record a cash purchase by hand.'),
    el('p', {},
      el('a.btn.btn-primary', { href: '/import', 'data-nav': 'import' }, 'Import CSV'),
      ' ',
      el('button.btn', { type: 'button', onclick: () => openManualEntry() }, 'Add cash transaction')),
  );
}

function emptyNoMatch() {
  return el('div.empty-state', {},
    el('h2', {}, 'No transactions match'),
    el('p', {}, 'Try widening the date range, removing an amount limit, or clearing filters.'),
    el('button.btn.btn-primary', { type: 'button', onclick: () => clearFilters() }, 'Clear all filters'),
  );
}

// ---- filters ----------------------------------------------------------------

function filterBar() {
  const f = state.filters;

  const search = el('input', {
    id: 'tf-q', type: 'search', value: f.q,
    placeholder: 'Payee or description\u2026',
  });
  search.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => applyFilter('q', search.value.trim()), 250);
  });

  const acctSel = el('select', { id: 'tf-account' },
    el('option', { value: '' }, 'All accounts'),
    state.accounts.map((a) => el('option', { value: String(a.id) }, a.name)));
  acctSel.value = f.accountId;
  acctSel.addEventListener('change', () => applyFilter('accountId', acctSel.value));

  const catSel = el('select', { id: 'tf-category' },
    el('option', { value: '' }, 'All categories'),
    categoryOptgroups());
  catSel.value = f.categoryId;
  if (catSel.value !== f.categoryId) catSel.value = '';
  catSel.addEventListener('change', () => {
    if (catSel.value && state.filters.uncategorized) {
      state.filters.uncategorized = false;
      const cb = document.getElementById('tf-unca');
      if (cb) cb.checked = false;
    }
    applyFilter('categoryId', catSel.value);
  });

  const unca = el('input', {
    id: 'tf-unca', type: 'checkbox', checked: f.uncategorized,
  });
  unca.addEventListener('change', () => {
    if (unca.checked) {
      state.filters.categoryId = '';
      catSel.value = '';
    }
    applyFilter('uncategorized', unca.checked);
  });

  const fromInput = el('input', { id: 'tf-from', type: 'date', value: f.from });
  fromInput.addEventListener('change', () => applyFilter('from', fromInput.value));
  const toInput = el('input', { id: 'tf-to', type: 'date', value: f.to });
  toInput.addEventListener('change', () => applyFilter('to', toInput.value));

  const minErr = el('span.field-error', { id: 'tf-min-err', hidden: true });
  const maxErr = el('span.field-error', { id: 'tf-max-err', hidden: true });
  const minInput = amountInput('tf-min', f.min, minErr);
  const maxInput = amountInput('tf-max', f.max, maxErr);

  return el('div.card.txn-filterbar', {},
    el('div.txn-filters', { role: 'search', 'aria-label': 'Transaction filters' },
      el('div.txn-field.txn-grow', {}, el('label', { for: 'tf-q' }, 'Search'), search),
      el('div.txn-field', {}, el('label', { for: 'tf-account' }, 'Account'), acctSel),
      el('div.txn-field', {}, el('label', { for: 'tf-category' }, 'Category'), catSel),
      el('div.txn-field.txn-checkfield', {},
        el('label.txn-inline-label', { for: 'tf-unca' }, unca, 'Uncategorized only')),
      el('div.txn-field', {}, el('label', { for: 'tf-from' }, 'From'), fromInput),
      el('div.txn-field', {}, el('label', { for: 'tf-to' }, 'To'), toInput),
      el('div.txn-field', {}, el('label', { for: 'tf-min' }, 'Min amount'), minInput, minErr),
      el('div.txn-field', {}, el('label', { for: 'tf-max' }, 'Max amount'), maxInput, maxErr),
    ),
  );
}

function amountInput(id, minorValue, errSpan) {
  const input = el('input', {
    id, type: 'text', inputmode: 'decimal', placeholder: '0.00',
    value: minorValue != null ? minorToDecimalText(minorValue) : '',
    autocomplete: 'off',
  });
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    if (raw === '') {
      errSpan.hidden = true;
      applyFilter(id === 'tf-min' ? 'min' : 'max', null);
      return;
    }
    const parsed = parseMoneyToMinor(raw);
    if (parsed == null) {
      errSpan.textContent = 'Use a number with up to 2 decimals, like 12.34';
      errSpan.hidden = false;
      return;
    }
    errSpan.hidden = true;
    applyFilter(id === 'tf-min' ? 'min' : 'max', parsed);
  });
  return input;
}

function categoryOptgroups() {
  const groups = new Map();
  for (const c of state.categories) {
    if (c.kind === 'group') continue;
    const g = c.parentName ?? 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  return [...groups.entries()].map(([g, list]) => el('optgroup', { label: g },
    list.map((c) => el('option', { value: String(c.id) }, c.name))));
}

function applyFilter(key, value) {
  state.filters[key] = value;
  state.offset = 0;
  syncUrl({ replace: false });
  draw().then((res) => {
    if (res) announce(`${res.total} ${res.total === 1 ? 'transaction matches' : 'transactions match'}`);
  });
}

function clearFilters() {
  state.filters = {
    q: '', accountId: '', categoryId: '', uncategorized: false,
    from: '', to: '', min: null, max: null,
  };
  state.offset = 0;
  syncUrl({ replace: false });
  announce('All filters cleared');
  draw();
}

function chipsRow() {
  const f = state.filters;
  const chips = [];
  if (f.q) chips.push(['q', `"${f.q}"`, () => { f.q = ''; }]);
  if (f.accountId) {
    const name = state.accounts.find((a) => String(a.id) === String(f.accountId))?.name ?? f.accountId;
    chips.push(['accountId', `Account: ${name}`, () => { f.accountId = ''; }]);
  }
  if (f.categoryId && !f.uncategorized) {
    const cat = state.categories.find((c) => String(c.id) === String(f.categoryId));
    chips.push(['categoryId', `Category: ${cat ? cat.name : f.categoryId}`, () => { f.categoryId = ''; }]);
  }
  if (f.uncategorized) chips.push(['uncategorized', 'Uncategorized', () => { f.uncategorized = false; }]);
  if (f.from) chips.push(['from', `From ${fmtDate(f.from)}`, () => { f.from = ''; }]);
  if (f.to) chips.push(['to', `Until ${fmtDate(f.to)}`, () => { f.to = ''; }]);
  if (f.min != null) chips.push(['min', `Amount \u2265 ${fmtMoney(f.min)}`, () => { f.min = null; }]);
  if (f.max != null) chips.push(['max', `Amount \u2264 ${fmtMoney(f.max)}`, () => { f.max = null; }]);

  if (!chips.length) return el('div.txn-chipsrow');

  const row = el('ul.txn-chipsrow', { 'aria-label': 'Active filters' },
    chips.map(([key, label, unset]) => el('li.txn-chip', { dataset: { key } },
      el('span.chip', {}, label),
      el('button.txn-chip-x', {
        type: 'button',
        'aria-label': `Remove filter ${label}`,
        onclick: () => { unset(); applyFilterDirect(); },
      }, '\u00D7'))));
  row.append(el('button.btn-ghost.btn.txn-clear-all', {
    type: 'button', onclick: () => clearFilters(),
  }, 'Clear all'));
  return row;
}

function applyFilterDirect() {
  state.offset = 0;
  syncUrl({ replace: false });
  draw().then((res) => {
    if (res) announce(`${res.total} ${res.total === 1 ? 'transaction matches' : 'transactions match'}`);
  });
}

// ---- selection / bulk -------------------------------------------------------

function bulkBar() {
  const sel = el('select', { id: 'tx-bulk-cat', 'aria-label': 'Category to apply to selection' },
    el('option', { value: '' }, 'Choose category\u2026'),
    el('option', { value: 'clear' }, 'Clear categories'),
    categoryOptgroups());
  const remember = el('input', { id: 'tx-bulk-remember', type: 'checkbox' });

  const bar = el('div.txn-bulkbar', { hidden: true },
    el('span.txn-bulk-count', {}, ''),
    sel,
    el('button.btn', {
      type: 'button',
      onclick: () => applyBulk(sel, remember),
    }, 'Apply'),
    el('label.txn-bulk-remember', { for: 'tx-bulk-remember' }, remember, 'Remember merchant'),
  );
  bar.refresh = () => {
    const n = state.selected.size;
    bar.hidden = n === 0;
    bar.querySelector('.txn-bulk-count').textContent = `${n} selected`;
  };
  bar.refresh();
  return bar;
}

async function applyBulk(sel, remember) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (sel.value === '') {
    announce('Choose a category to apply first');
    sel.focus();
    return;
  }
  const clearing = sel.value === 'clear';
  const body = { ids, categoryId: clearing ? null : Number(sel.value) };
  if (!clearing && remember.checked) body.remember = true;
  try {
    const res = await api('/transactions/bulk', { method: 'POST', body });
    if (!clearing && remember.checked) pushMru(body.categoryId);
    const verb = clearing ? 'Cleared categories on' : 'Categorized';
    state.selected.clear();
    toast(`${verb} ${res.updated} ${res.updated === 1 ? 'transaction' : 'transactions'}`,
      'success',
      { label: 'Undo', onClick: () => undoLastAction() });
    announce(`${verb.toLowerCase()} ${res.updated} ${res.updated === 1 ? 'transaction' : 'transactions'}`);
    await draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function undoLastAction() {
  try {
    const res = await api('/undo', { method: 'POST' });
    if (res.undone === null) {
      toast('Nothing left to undo', 'info');
    } else {
      announce(`Undid ${res.undone.replace('_', ' ')}`);
    }
    await draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- table ------------------------------------------------------------------

function tableView(res) {
  const table = el('table.txn-table', {},
    el('caption', {}, `Transactions \u2014 ${res.total} ${res.total === 1 ? 'match' : 'matches'} for the current filters`),
    el('thead', {}, el('tr', {},
      selectAllTh(res),
      sortTh('Date', 'date'),
      sortTh('Payee', 'payee'),
      sortTh('Category', 'category'),
      sortTh('Account', 'account'),
      sortTh('Amount', 'amount', true))),
    el('tbody', {}, res.rows.map((row) => tableRow(row))),
  );

  const headCheck = table.querySelector('.txn-all-check');
  headCheck.addEventListener('change', () => {
    const pageIds = res.rows.map((r) => r.id);
    for (const id of pageIds) {
      if (headCheck.checked) state.selected.add(id);
      else state.selected.delete(id);
    }
    for (const cb of table.querySelectorAll('.txn-row-check')) {
      cb.checked = headCheck.checked;
      cb.closest('tr').classList.toggle('selected', headCheck.checked);
    }
    refreshHeadCheck(table, res);
    refreshBulkBar();
    announce(`${state.selected.size} selected`);
  });

  const tbody = table.querySelector('tbody');
  tbody.addEventListener('change', (e) => {
    const cb = e.target.closest('.txn-row-check');
    if (!cb) return;
    const id = Number(cb.closest('tr').dataset.id);
    if (cb.checked) state.selected.add(id);
    else state.selected.delete(id);
    cb.closest('tr').classList.toggle('selected', cb.checked);
    refreshHeadCheck(table, res);
    refreshBulkBar();
  });

  const firstRow = tbody.querySelector('tr[data-id]');
  if (firstRow) {
    const focusTarget = state.lastFocusId != null
      ? tbody.querySelector(`tr[data-id="${state.lastFocusId}"]`)
      : null;
    (focusTarget ?? firstRow).tabIndex = 0;
  }

  return el('div.txn-table-wrap', {}, table);
}

function refreshHeadCheck(table, res) {
  const head = table.querySelector('.txn-all-check');
  const pageIds = res.rows.map((r) => r.id);
  const chosen = pageIds.filter((id) => state.selected.has(id)).length;
  head.checked = pageIds.length > 0 && chosen === pageIds.length;
  head.indeterminate = chosen > 0 && chosen < pageIds.length;
}

function refreshBulkBar() {
  const bar = document.querySelector('.txn-bulkbar');
  if (bar?.refresh) bar.refresh();
}

function selectAllTh(res) {
  const allOnPage = res.rows.every((r) => state.selected.has(r.id));
  const someOnPage = res.rows.some((r) => state.selected.has(r.id));
  const cb = el('input.txn-all-check', {
    type: 'checkbox',
    checked: res.rows.length > 0 && allOnPage,
    'aria-label': 'Select all rows on this page',
  });
  cb.indeterminate = someOnPage && !allOnPage;
  return el('th.txn-col-select', { scope: 'col' }, cb);
}

function sortTh(label, key, numeric = false) {
  const active = state.sort.key === key;
  const dir = active ? state.sort.dir : null;
  const glyph = !active ? '\u2195' : dir === 'asc' ? '\u25B2' : '\u25BC';
  return el('th' + (numeric ? '.num' : ''), {
    scope: 'col',
    'aria-sort': active ? (dir === 'asc' ? 'ascending' : 'descending') : null,
  },
  el('button.sort-btn', {
    type: 'button',
    onclick: () => toggleSort(key),
    title: key === 'account' ? 'Sorts the current page' : `Sort by ${label.toLowerCase()}`,
  }, label, el('span.sort-ind' + (active ? '.active' : ''), { 'aria-hidden': 'true' }, glyph)));
}

function toggleSort(key) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sort.key = key;
    state.sort.dir = DEFAULT_DIR[key];
  }
  state.offset = 0;
  syncUrl({ replace: true });
  announce(`Sorted by ${key}, ${state.sort.dir === 'asc' ? 'oldest or smallest first' : 'newest or largest first'}`);
  draw();
}

function tableRow(row) {
  state.rowById.set(row.id, row);
  const selected = state.selected.has(row.id);
  const tr = el('tr', {
    dataset: { id: String(row.id) },
    tabindex: '-1',
    'aria-selected': selected ? 'true' : 'false',
  }, [
    el('td.txn-col-select', {},
      el('input.txn-row-check', {
        type: 'checkbox',
        checked: selected,
        'aria-label': `Select transaction ${row.payee} ${row.date}`,
      })),
    el('td.txn-col-date', {}, fmtDate(row.date)),
    el('td', {},
      el('span.txn-payee', { title: row.description || row.payee }, row.payee)),
    categoryCell(row),
    el('td', {}, row.accountName),
    el('td.num', {},
      el('span' + (row.amountMinor < 0 ? '.amount-neg' : ''), {}, fmtMoney(row.amountMinor))),
  ]);
  if (selected) tr.classList.add('selected');
  tr.addEventListener('click', (e) => {
    if (e.target.closest('input, button, a, label')) return;
    openDetail(row.id);
  });
  return tr;
}

function categoryCell(row) {
  const kids = [];
  if (row.splitCount > 0) {
    kids.push(el('button.chip.txn-split-chip', {
      type: 'button',
      title: 'Split into parts \u2014 open details',
      onclick: (e) => { e.stopPropagation(); openDetail(row.id); },
    }, `split (${row.splitCount})`));
  }
  if (row.categoryId == null) {
    kids.push(el('span.chip.chip-warn', { title: 'Not categorized yet' }, 'Uncategorized'));
  } else {
    const cat = state.categories.find((c) => c.id === row.categoryId);
    const label = row.categoryName ?? cat?.name ?? `Category ${row.categoryId}`;
    const full = cat?.parentName ? `${cat.parentName} \u203A ${label}` : label;
    kids.push(el('span.chip.txn-cat-chip', { title: full }, label));
  }
  kids.push(sourceBadge(row));
  return el('td.txn-cat', {}, ...kids);
}

function sourceBadge(row) {
  const src = row.categorySource;
  if (!src) return null;
  const meta = src === 'learned'
    ? ['L', 'Learned from your corrections']
    : src === 'manual'
      ? ['M', 'Manual']
      : ['R', row.ruleName ? `Assigned by rule ${row.ruleName}` : 'Assigned by a rule'];
  return el('span.txn-src', {
    role: 'img',
    title: `Category ${meta[1]}`,
    'aria-label': `Category ${meta[1]}`,
  }, meta[0]);
}

function pageBar(res) {
  const from = res.total === 0 ? 0 : res.offset + 1;
  const to = Math.min(res.offset + res.limit, res.total);
  return el('div.txn-pagebar', {},
    el('span.txn-page-status', { 'aria-live': 'polite' },
      `Showing ${from}\u2013${to} of ${res.total}`),
    el('span', { style: 'flex:1' }),
    el('button.btn.btn-sm', {
      type: 'button',
      disabled: res.offset <= 0,
      onclick: () => changePage(res.offset - res.limit),
    }, '\u2039 Previous'),
    el('button.btn.btn-sm', {
      type: 'button',
      disabled: res.offset + res.limit >= res.total,
      onclick: () => changePage(res.offset + res.limit),
    }, 'Next \u203A'),
  );
}

function changePage(offset) {
  state.offset = Math.max(0, offset);
  syncUrl({ replace: true });
  draw().then((res) => {
    if (res && res.total > 0) {
      const from = res.offset + 1;
      const to = Math.min(res.offset + res.limit, res.total);
      announce(`Showing ${from} to ${to} of ${res.total}`);
    }
  });
}

// ---- keyboard ----------------------------------------------------------------

function dialogOpen() {
  return Boolean(document.querySelector('.dialog-overlay'));
}

function onPageKeydown(e) {
  if (dialogOpen()) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

  const row = e.target.closest?.('tr[data-id]');
  const tbody = document.querySelector('.txn-table tbody');
  if (!tbody) return;

  if ((e.key === 'j' || e.key === 'ArrowDown') && !row) {
    const first = tbody.querySelector('tr[data-id]');
    if (first) moveFocus(null, first);
    return;
  }

  if (!row) {
    if (e.key === '?') { e.preventDefault(); openShortcuts(); }
    return;
  }

  const rows = [...tbody.querySelectorAll('tr[data-id]')];
  const idx = rows.indexOf(row);

  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      if (idx < rows.length - 1) moveFocus(row, rows[idx + 1]);
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      if (idx > 0) moveFocus(row, rows[idx - 1]);
      break;
    case ' ':
      e.preventDefault();
      toggleRowSelection(row);
      break;
    case 'Enter':
      e.preventDefault();
      openDetail(Number(row.dataset.id));
      break;
    case 'c':
    case 'C':
      e.preventDefault();
      openPicker(Number(row.dataset.id));
      break;
    case '?':
      e.preventDefault();
      openShortcuts();
      break;
    default:
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        quickAssign(Number(row.dataset.id), Number(e.key) - 1);
      }
  }
}

function moveFocus(current, next) {
  if (current) current.tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
  state.lastFocusId = Number(next.dataset.id);
}

function toggleRowSelection(tr) {
  const cb = tr.querySelector('.txn-row-check');
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
}

function refocusRow(id) {
  const tr = document.querySelector(`.txn-table tr[data-id="${id}"]`);
  if (!tr) return;
  const tbody = tr.parentElement;
  for (const r of tbody.querySelectorAll('tr[data-id]')) r.tabIndex = -1;
  tr.tabIndex = 0;
  tr.focus();
  state.lastFocusId = id;
}

async function quickAssign(id, mruIndex) {
  const catId = state.mru[mruIndex];
  const row = state.rowById.get(id);
  if (!row) return;
  if (catId == null) {
    announce('No recent category in that slot yet. Press c to pick one.');
    return;
  }
  const cat = state.categories.find((c) => c.id === catId);
  try {
    const updated = await api(`/transactions/${id}`, {
      method: 'PATCH',
      body: { categoryId: catId },
    });
    pushMru(catId);
    patchRowInPlace(id, updated);
    announce(`${row.payee} moved to ${cat ? cat.name : `category ${catId}`}${mruIndex === 0 ? '' : `, slot ${mruIndex + 1}`}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function patchRowInPlace(id, updated) {
  const row = state.rowById.get(id);
  if (!row) return;
  Object.assign(row, {
    categoryId: updated.categoryId,
    categoryName: updated.categoryName,
    categorySource: updated.categorySource,
    appliedRuleId: updated.appliedRuleId,
    ruleName: updated.ruleName,
    ruleSource: updated.ruleSource,
  });
  const tr = document.querySelector(`.txn-table tr[data-id="${id}"]`);
  const cell = tr?.querySelector('.txn-cat');
  if (cell) {
    const fresh = categoryCell(row);
    cell.className = fresh.className;
    cell.replaceChildren(...fresh.childNodes);
  }
}

// ---- MRU categories ----------------------------------------------------------

function loadMru() {
  try {
    const raw = JSON.parse(localStorage.getItem(MRU_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((n) => Number.isSafeInteger(n)).slice(0, 9);
  } catch {
    return [];
  }
}

function saveMru() {
  try { localStorage.setItem(MRU_KEY, JSON.stringify(state.mru)); } catch { /* private mode */ }
}

function pushMru(catId) {
  state.mru = [catId, ...state.mru.filter((id) => id !== catId)].slice(0, 9);
  saveMru();
}

// ---- detail dialog ------------------------------------------------------------

async function openDetail(id) {
  let txn;
  try {
    txn = await api(`/transactions/${id}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  state.lastFocusId = id;

  const grid = el('dl.txn-detail-grid', {},
    el('dt', {}, 'Date'), el('dd', {}, fmtDate(txn.date)),
    el('dt', {}, 'Payee'), el('dd', {}, txn.payee),
    txn.description ? (el('dt', {}, 'Description'), el('dd', {}, txn.description)) : null,
    el('dt', {}, 'Account'), el('dd', {}, txn.accountName),
    el('dt', {}, 'Amount'),
    el('dd', {}, el('span.num' + (txn.amountMinor < 0 ? '.amount-neg' : ''), {}, fmtMoney(txn.amountMinor))),
    el('dt', {}, 'Category'),
    el('dd', {}, txn.categoryId == null
      ? el('span.chip.chip-warn', {}, 'Uncategorized')
      : el('span', {}, txn.categoryName ?? `Category ${txn.categoryId}`, sourceBadge(txn))),
    el('dt', {}, 'Rule'),
    el('dd', {}, txn.appliedRuleId && txn.ruleName
      ? `${txn.ruleName} (${txn.ruleSource ?? 'rule'})`
      : '\u2014'),
    el('dt', {}, 'Fingerprint'),
    el('dd', {}, el('code.txn-fp', { title: txn.fingerprint }, truncateMiddle(String(txn.fingerprint ?? ''), 44))),
    el('dt', {}, 'Notes'),
    el('dd', {},
      el('textarea.txn-notes', {
        rows: 2,
        readonly: true,
        'aria-label': 'Notes (read-only)',
        title: 'Notes are shown as recorded during import; editing is not supported yet',
      }, txn.notes ?? '')),
  );

  const splitsSection = txn.splits.length
    ? el('div', {},
      el('h3', {}, `Split into ${txn.splits.length} parts`),
      el('table.txn-splits', {},
        el('caption.visually-hidden', {}, 'Split parts'),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, 'Amount'),
          el('th', { scope: 'col' }, 'Category'),
          el('th', { scope: 'col' }, 'Note'))),
        el('tbody', {}, txn.splits.map((s) => el('tr', {},
          el('td', {}, el('span.num' + (s.amountMinor < 0 ? '.amount-neg' : ''), {}, fmtMoney(s.amountMinor))),
          el('td', {}, s.categoryName ?? el('span.chip.chip-warn', {}, 'Uncategorized')),
          el('td', {}, s.note || ''))))),
      el('div.txn-detail-actions', {},
        el('button.btn', {
          type: 'button',
          onclick: () => confirmUnsplit(txn),
        }, 'Unsplit')))
    : el('div.txn-detail-actions', {},
      el('button.btn', {
        type: 'button',
        onclick: () => { dlg.close(); openSplitEditor(txn.id); },
      }, 'Split'),
      el('button.btn', {
        type: 'button',
        onclick: () => { dlg.close(); openPicker(txn.id); },
      }, 'Recategorize'));

  const dlg = openDialog({
    title: `Transaction: ${txn.payee}`,
    onClose: () => refocusRow(id),
    content: el('div', {}, grid, splitsSection),
  });
}

function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\u2026${s.slice(s.length - half)}`;
}

async function confirmUnsplit(txn) {
  const ok = await confirmDialog({
    title: 'Remove this split?',
    message: `Delete the ${txn.splits.length} parts of this transaction? The original ${fmtMoney(txn.amountMinor)} entry stays, with its category.`,
    confirmLabel: 'Unsplit',
  });
  if (!ok) return;
  try {
    await api(`/transactions/${txn.id}/split`, { method: 'DELETE' });
    toast('Split removed', 'success');
    announce('Split removed');
    await draw();
    refocusRow(txn.id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- category picker -----------------------------------------------------------

async function openPicker(id) {
  let txn = state.rowById.get(id);
  try {
    txn = await api(`/transactions/${id}`);
  } catch { /* fall back to list row */ }

  const sel = el('select', { id: 'tx-pick-cat' },
    el('option', { value: '' }, 'Uncategorized'),
    categoryOptgroups());
  sel.value = txn.categoryId != null ? String(txn.categoryId) : '';

  const remember = el('input', { id: 'tx-pick-remember', type: 'checkbox' });

  const errChip = el('div.txn-errchip', { role: 'alert', hidden: true });

  const dlg = openDialog({
    title: `Recategorize: ${txn.payee}`,
    onClose: () => refocusRow(id),
    content: el('div', {},
      el('div.txn-form', {},
        el('div', {}, el('label', { for: 'tx-pick-cat' }, 'Category'), sel),
        el('label.txn-bulk-remember', { for: 'tx-pick-remember' }, remember,
          'Remember this merchant\u2019s category'),
        errChip,
        el('div.dialog-actions', {},
          el('button.btn.btn-primary', {
            type: 'button',
            onclick: async () => {
              const body = { categoryId: sel.value === '' ? null : Number(sel.value) };
              if (remember.checked && body.categoryId != null) body.remember = true;
              try {
                const updated = await api(`/transactions/${id}`, { method: 'PATCH', body });
                if (body.categoryId != null) pushMru(body.categoryId);
                patchRowInPlace(id, updated);
                dlg.close();
                const cat = state.categories.find((c) => c.id === body.categoryId);
                announce(`${txn.payee} moved to ${cat ? cat.name : 'Uncategorized'}`);
                toast(`Moved to ${cat ? cat.name : 'Uncategorized'}`, 'success');
                await draw();
                refocusRow(id);
              } catch (err) {
                errChip.textContent = err.message;
                errChip.hidden = false;
              }
            },
          }, 'Apply'))),
    ),
  });
}

// ---- split editor ---------------------------------------------------------------

async function openSplitEditor(id) {
  let txn;
  try {
    txn = await api(`/transactions/${id}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (txn.splits.length > 0) {
    toast('This transaction already has splits', 'info');
    refocusRow(id);
    return;
  }

  const parentSign = txn.amountMinor < 0 ? -1 : 1;
  const parts = [];
  const partsBody = el('tbody');

  function addPartRow() {
    const amount = el('input', {
      type: 'text', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off',
      'aria-label': `Part ${parts.length + 1} amount`,
    });
    const cat = el('select', { 'aria-label': `Part ${parts.length + 1} category` },
      el('option', { value: '' }, 'Uncategorized'),
      categoryOptgroups());
    const note = el('input', {
      type: 'text', maxlength: '200', placeholder: 'Optional note',
      'aria-label': `Part ${parts.length + 1} note`,
    });
    const removeBtn = el('button.btn.btn-sm.btn-ghost.txn-remove-part', {
      type: 'button',
      'aria-label': `Remove part ${parts.length + 1}`,
      onclick: () => {
        const i = parts.indexOf(part);
        if (i !== -1) parts.splice(i, 1);
        tr.remove();
        renumber();
        recalc();
      },
    }, '\u00D7');
    const tr = el('tr', {},
      el('td', {}, el('span.num.txn-part-num', {}, String(parts.length + 1))),
      el('td', {}, amount),
      el('td', {}, cat),
      el('td', {}, note),
      el('td.txn-part-remove', {}, removeBtn));
    const part = { tr, amount, cat, note };
    for (const inp of [amount, cat, note]) inp.addEventListener('input', recalc);
    parts.push(part);
    partsBody.append(tr);
    renumber();
  }

  function renumber() {
    parts.forEach((p, i) => {
      p.tr.querySelector('.txn-part-num').textContent = String(i + 1);
      p.amount.setAttribute('aria-label', `Part ${i + 1} amount`);
      p.cat.setAttribute('aria-label', `Part ${i + 1} category`);
      p.note.setAttribute('aria-label', `Part ${i + 1} note`);
      p.tr.querySelector('.txn-remove-part').setAttribute('aria-label', `Remove part ${i + 1}`);
    });
  }

  const remainingVal = el('span.num.txn-remaining', {}, '');
  const remainingWrap = el('span', {},
    el('span.txn-remaining-label', {}, 'Remaining: '), remainingVal);
  const errChip = el('div.txn-errchip', { role: 'alert', hidden: true });
  const addBtn = el('button.btn.btn-sm', { type: 'button', onclick: () => { addPartRow(); recalc(); } }, '+ Add part');
  const cancelBtn = el('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel');
  const saveBtn = el('button.btn.btn-primary', { type: 'button', disabled: true }, 'Save split');

  function recalc() {
    let sum = 0;
    let filled = 0;
    let badIndex = -1;
    parts.forEach((p, i) => {
      const raw = p.amount.value.trim();
      if (raw === '') return;
      const parsed = parseMoneyToMinor(raw);
      if (parsed == null || parsed === 0) {
        if (badIndex === -1) badIndex = i + 1;
        return;
      }
      sum += Math.abs(parsed) * parentSign;
      filled += 1;
    });
    const remaining = txn.amountMinor - sum;
    remainingVal.textContent = remaining === 0 ? 'Balanced' : fmtMoney(remaining);
    remainingVal.className = `num txn-remaining ${remaining === 0 ? 'ok' : 'bad'}`;

    const ready = filled >= 2 && filled === parts.length && remaining === 0;
    saveBtn.disabled = !ready;
    if (ready) {
      errChip.hidden = true;
    } else {
      errChip.hidden = false;
      errChip.textContent = badIndex !== -1
        ? `Part ${badIndex}: enter a non-zero amount with up to 2 decimals.`
        : remaining === 0
          ? 'A split needs at least 2 parts.'
          : `Parts leave ${fmtMoney(Math.abs(remaining))} ${remaining < 0 ? 'unassigned' : 'over'} \u2014 parts must sum to exactly ${fmtMoney(txn.amountMinor)}.`;
    }
  }

  saveBtn.addEventListener('click', async () => {
    const body = {
      parts: parts.map((p) => {
        const raw = parseMoneyToMinor(p.amount.value.trim());
        return {
          amountMinor: Math.abs(raw) * parentSign,
          categoryId: p.cat.value === '' ? null : Number(p.cat.value),
          note: p.note.value.trim(),
        };
      }),
    };
    try {
      await api(`/transactions/${id}/split`, { method: 'POST', body });
      dlg.close();
      toast(`Split into ${body.parts.length} parts`, 'success');
      announce(`Split ${txn.payee} into ${body.parts.length} parts`);
      await draw();
      refocusRow(id);
    } catch (err) {
      errChip.textContent = err.message;
      errChip.hidden = false;
      errChip.scrollIntoView({ block: 'nearest' });
    }
  });

  addPartRow();
  addPartRow();
  recalc();

  const dlg = openDialog({
    title: 'Split transaction',
    onClose: () => refocusRow(id),
    content: el('div', {},
      el('p.txn-hint', {},
        `Splitting ${fmtMoney(txn.amountMinor)} (${txn.payee}). Enter each part as a positive amount; `,
        `parts of this ${parentSign < 0 ? 'expense' : 'income'} are stored ${parentSign < 0 ? 'negative' : 'positive'} automatically.`),
      el('table.txn-parts', {},
        el('caption.visually-hidden', {}, 'Split parts'),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, '#'),
          el('th', { scope: 'col' }, 'Amount'),
          el('th', { scope: 'col' }, 'Category'),
          el('th', { scope: 'col' }, 'Note'),
          el('th', { scope: 'col' }, ''))),
        partsBody),
      el('div.txn-split-foot', {}, remainingWrap, el('span', { style: 'flex:1' }), addBtn),
      errChip,
      el('div.dialog-actions', {}, cancelBtn, saveBtn)),
  });
}

// ---- manual entry -----------------------------------------------------------------

function openManualEntry() {
  const acctSel = el('select', { id: 'tx-man-acct' },
    state.accounts.map((a) => el('option', { value: String(a.id) }, a.name)));
  if (state.accounts.length === 1) acctSel.value = String(state.accounts[0].id);

  const dateInput = el('input', { id: 'tx-man-date', type: 'date', value: todayISO() });
  const payeeInput = el('input', { id: 'tx-man-payee', type: 'text', maxlength: '120' });
  const amountInput = el('input', {
    id: 'tx-man-amount', type: 'text', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off',
  });
  const expRadio = el('input', { type: 'radio', name: 'tx-man-kind', value: 'expense', checked: true });
  const incRadio = el('input', { type: 'radio', name: 'tx-man-kind', value: 'income' });
  const descInput = el('input', { id: 'tx-man-desc', type: 'text', maxlength: '300' });
  const errChip = el('div.txn-errchip', { role: 'alert', hidden: true });

  const dlg = openDialog({
    title: 'Add cash transaction',
    content: el('div', {},
      el('div.txn-form', {},
        el('div.form-row', {},
          el('div', {}, el('label', { for: 'tx-man-acct' }, 'Account'), acctSel),
          el('div', {}, el('label', { for: 'tx-man-date' }, 'Date'), dateInput)),
        el('div.form-row', {},
          el('div.txn-grow', {}, el('label', { for: 'tx-man-payee' }, 'Payee'), payeeInput),
          el('div', {}, el('label', { for: 'tx-man-amount' }, 'Amount'), amountInput)),
        el('div', {},
          el('span.label-like', {}, 'Type'),
          el('div.txn-radio-row', {},
            el('label', {}, expRadio, 'Expense'),
            el('label', {}, incRadio, 'Income'))),
        el('div', {}, el('label', { for: 'tx-man-desc' }, 'Description (optional)'), descInput),
        errChip,
        el('div.dialog-actions', {},
          el('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
          el('button.btn.btn-primary', { type: 'button', onclick: submit }, 'Add transaction'))),
    ),
  });

  async function submit() {
    errChip.hidden = true;
    const problems = [];
    const payee = payeeInput.value.trim();
    if (!payee) problems.push('Payee is required.');
    const parsed = parseMoneyToMinor(amountInput.value.trim());
    if (parsed == null || parsed === 0) {
      problems.push('Amount must be a non-zero number with up to 2 decimals, like 12.34.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) problems.push('Pick a date.');
    if (problems.length) {
      errChip.textContent = problems.join(' ');
      errChip.hidden = false;
      return;
    }
    const sign = incRadio.checked ? 1 : -1;
    try {
      const created = await api('/transactions/manual', {
        method: 'POST',
        body: {
          accountId: Number(acctSel.value),
          date: dateInput.value,
          payee,
          amountMinor: Math.abs(parsed) * sign,
          description: descInput.value.trim(),
        },
      });
      dlg.close();
      state.totalTxns += 1;
      toast(`Added ${created.payee} (${fmtMoney(created.amountMinor)})`, 'success');
      announce(`Added cash transaction ${created.payee}`);
      await draw();
    } catch (err) {
      errChip.textContent = err.message;
      errChip.hidden = false;
    }
  }
}

// ---- shortcuts help -----------------------------------------------------------------

function openShortcuts() {
  const keys = [
    [['j', '\u2193'], 'Move down one transaction'],
    [['k', '\u2191'], 'Move up one transaction'],
    [['Space'], 'Select or deselect the focused row'],
    [['Enter'], 'Open transaction details'],
    [['c'], 'Change the focused row\u2019s category'],
    [['1', '\u2026', '9'], 'Assign a recently used category'],
    [['?'], 'Show this help'],
    [['Ctrl', '+', 'Z'], 'Undo the last bulk change (works anywhere)'],
  ];
  openDialog({
    title: 'Keyboard shortcuts',
    content: el('div', {},
      el('dl.txn-keys', {},
        keys.flatMap(([k, desc]) => [
          el('dt', {}, k.map((part) => el('kbd.txn-kbd', {}, part))),
          el('dd', {}, desc),
        ])),
      el('p.txn-hint', { style: 'margin-top:14px' },
        'Keys are ignored while you are typing in a field.'),
    ),
  });
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
