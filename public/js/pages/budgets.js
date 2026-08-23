import { api, el, fmtMoney, toast, announce, openDialog } from '../lib.js';

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export async function render(view) {
  ensureStyles();
  view.innerHTML = '';
  view.append(skeleton());

  let meta;
  try {
    meta = await api('/meta');
  } catch (err) {
    view.innerHTML = '';
    view.append(errorPanel(err));
    return;
  }

  if (!meta.counts.accounts) {
    view.innerHTML = '';
    view.append(noAccountsView());
    return;
  }

  const bounds = await monthBounds();
  const state = { month: clampMonth(todayMonth(), bounds), bounds, seq: 0 };
  await draw(view, state);
}

function ensureStyles() {
  if (document.querySelector('link[data-pages-css="budgets"]')) return;
  document.head.append(el('link', {
    rel: 'stylesheet',
    href: '/css/pages.css',
    'data-pages-css': 'budgets',
  }));
}

function skeleton() {
  const wrap = el('div.skeleton-wrap');
  for (let i = 0; i < 4; i += 1) wrap.append(el('div.skeleton-bar'));
  return wrap;
}

function errorPanel(err) {
  return el('div.error-panel', {}, `Could not load budgets: ${err.message}`);
}

function noAccountsView() {
  return el('div.empty-state', {},
    el('h2', {}, 'Add your data first'),
    el('p', {}, 'Budgets compare a month of spending against a plan per category, so import some transactions before setting limits.'),
    el('a.btn.btn-primary', { href: '/import', 'data-nav': 'import' }, 'Import CSV'),
  );
}

async function monthBounds() {
  try {
    const [first, last] = await Promise.all([
      api('/transactions?limit=1&sort=date&dir=asc'),
      api('/transactions?limit=1&sort=date&dir=desc'),
    ]);
    const min = first.rows[0]?.date?.slice(0, 7);
    const max = last.rows[0]?.date?.slice(0, 7);
    if (min && max) return { min, max: max > todayMonth() ? max : todayMonth() };
  } catch {
    /* fall through */
  }
  return { min: todayMonth(), max: todayMonth() };
}

async function draw(view, state) {
  const seq = (state.seq += 1);
  let data;
  let categories;
  try {
    [data, categories] = await Promise.all([
      api(`/budgets?month=${state.month}`),
      api('/categories'),
    ]);
  } catch (err) {
    view.innerHTML = '';
    view.append(errorPanel(err));
    return;
  }
  if (seq !== state.seq) return;

  const root = el('div.bud-page', {},
    pageHead(),
    monthCard(state),
    uncategorizedNote(data),
    setBudgetPanel(categories, data.budgets, state),
    budgetBody(data, state),
  );

  view.innerHTML = '';
  view.append(root);
  announce(`Budgets for ${monthLabel(state.month)}: ${data.budgets.length} set`);
}

function pageHead() {
  return el('div.page-head', {},
    el('h1', {}, 'Budgets'),
    el('span.page-sub', {}, 'A monthly spending plan per category'),
  );
}

function monthCard(state) {
  const prevDisabled = state.month <= state.bounds.min;
  const nextDisabled = state.month >= state.bounds.max;

  const input = el('input', {
    type: 'month',
    value: state.month,
    min: state.bounds.min,
    max: state.bounds.max,
    id: 'bud-month-input',
    'aria-label': 'Month',
  });
  input.addEventListener('change', () => {
    const v = /^\d{4}-\d{2}$/.test(input.value) ? input.value : state.month;
    input.value = v;
    setMonth(state, v);
  });

  const prevBtn = el('button.btn.btn-sm', {
    type: 'button',
    'aria-label': 'Previous month',
    disabled: prevDisabled,
    onclick: () => setMonth(state, shiftMonth(state.month, -1)),
  }, '\u2039');
  const nextBtn = el('button.btn.btn-sm', {
    type: 'button',
    'aria-label': 'Next month',
    disabled: nextDisabled,
    onclick: () => setMonth(state, shiftMonth(state.month, 1)),
  }, '\u203A');

  return el('div.card.bud-month-card', {},
    el('div.flex-between', {},
      el('h2', {}, monthLabel(state.month)),
      el('div.bud-controls', {}, prevBtn, input, nextBtn),
    ),
  );
}

function setMonth(state, month) {
  if (month === state.month) return;
  state.month = clampMonth(month, state.bounds);
  draw(document.getElementById('view'), state).then(() => {
    const input = document.getElementById('bud-month-input');
    if (input && input.isConnected) input.focus({ preventScroll: true });
  });
}

function uncategorizedNote(data) {
  const u = data.uncategorized;
  if (!u || !u.count) return null;
  const noun = u.count === 1 ? 'transaction' : 'transactions';
  const verb = u.count === 1 ? 'is' : 'are';
  return el('div.bud-note', { role: 'status' },
    el('span', {},
      `${u.count} uncategorized ${noun} this month (${fmtMoney(u.totalMinor)}) ${verb} not counted against any budget. `),
    el('a.btn.btn-sm', { href: '/transactions?uncategorized=1', 'data-nav': 'transactions' }, 'Review now'),
  );
}

function budgetBody(data, state) {
  if (!data.budgets.length) return emptyState();
  return tableCard(data.budgets, state);
}

function emptyState() {
  return el('div.card.empty-state.bud-empty', {},
    el('h2', {}, 'No budgets yet'),
    el('p', {}, 'A budget is a monthly spending plan for one category. Each month Ledgerlight compares what you actually spent against the plan \u2014 set it once and every month is checked automatically.'),
    el('p.muted', {}, 'Budgets apply to every month until you change them; there are no rollovers.'),
    el('button.btn.btn-primary.bud-empty-cta', {
      type: 'button',
      onclick: focusNewBudgetForm,
    }, 'Set your first budget'),
  );
}

function focusNewBudgetForm() {
  const select = document.getElementById('bud-new-cat');
  if (!select) return;
  select.scrollIntoView({ block: 'center' });
  select.focus();
}

function tableCard(budgets, state) {
  const table = el('table.bud-table', {},
    el('caption', {}, `Budgets for ${monthLabel(state.month)}, most-used first`),
    el('thead', {}, el('tr', {},
      thCol('Category'),
      thCol('Monthly budget', true),
      thCol('Spent', true),
      thCol('Remaining', true),
      thCol('Progress'),
      thCol('Status'),
      thCol('Actions'),
    )),
    el('tbody', {}, budgets.map((b) => row(b, state))),
  );
  const scroll = el('div.bud-scroll', {}, table);
  return el('div.card.bud-table-card', {}, scroll);
}

function thCol(text, isNum) {
  return el('th' + (isNum ? '.num' : ''), { scope: 'col' }, text);
}

function row(b, state) {
  const pct = Math.min(b.pctUsedBps, 10000) / 100;
  const roundedPct = Math.round(pct);

  const track = el('div.progress-track', {
    role: 'progressbar',
    'aria-valuenow': String(roundedPct),
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-label': `${roundedPct}% of the monthly budget used`,
  });
  const fillClass = b.state === 'over' ? '.over' : b.state === 'near' ? '.near' : '';
  track.append(el('div.progress-fill' + fillClass, { style: `width:${pct}%` }));

  return el('tr', {},
    el('td', {},
      el('span.bud-cat-name', {}, b.categoryName),
      b.parentName ? el('div.muted.bud-cat-parent', {}, b.parentName) : null,
    ),
    el('td.num', {}, fmtMoney(b.monthlyAmountMinor)),
    el('td.num', {}, fmtMoney(Math.abs(b.spentMinor))),
    el('td.num' + (b.remainingMinor < 0 ? '.amount-neg' : ''), {}, fmtMoney(b.remainingMinor)),
    el('td.bud-progress-cell', {}, track, el('span.muted.num.bud-pct', {}, `${roundedPct}%`)),
    el('td', {}, stateChip(b)),
    el('td.bud-actions', {},
      el('button.btn.btn-sm', { type: 'button', onclick: () => editDialog(b, state) }, 'Edit')),
  );
}

function stateChip(b) {
  if (b.state === 'over') {
    return el('span.chip.chip-neg.bud-state-chip', { title: 'Over budget' },
      `\u25B2 Over by ${fmtMoney(Math.abs(b.remainingMinor))}`);
  }
  if (b.state === 'near') {
    return el('span.chip.chip-warn.bud-state-chip', { title: 'Close to the limit' },
      '! Near limit');
  }
  return el('span.chip.chip-pos.bud-state-chip', {}, '\u2713 Under budget');
}

function editDialog(b, state) {
  const amountInput = el('input', {
    type: 'text',
    value: minorToMajorString(b.monthlyAmountMinor),
    inputmode: 'decimal',
    autocomplete: 'off',
    id: 'bud-edit-amount',
    'aria-describedby': 'bud-edit-error',
  });
  const errLine = el('div.field-error', { id: 'bud-edit-error', hidden: true });

  function showErr(msg) {
    errLine.textContent = msg;
    errLine.hidden = false;
  }

  const saveBtn = el('button.btn.btn-primary', { type: 'button' }, 'Save changes');
  saveBtn.addEventListener('click', async () => {
    errLine.hidden = true;
    const parsed = parseAmountToMinor(amountInput.value);
    if (parsed == null) {
      showErr('Enter an amount like 250 or 250.00 \u2014 two decimal places at most.');
      amountInput.focus();
      return;
    }
    if (parsed <= 0) {
      showErr('The monthly amount must be greater than zero.');
      amountInput.focus();
      return;
    }
    saveBtn.disabled = true;
    try {
      await api('/budgets', {
        method: 'PUT',
        body: { categoryId: b.categoryId, monthlyAmountMinor: parsed },
      });
      dlg.close();
      toast(`Budget updated for ${b.categoryName}`, 'success');
      announce(`Budget updated for ${b.categoryName}`);
      draw(document.getElementById('view'), state);
    } catch (err) {
      showErr(err.message);
      saveBtn.disabled = false;
    }
  });

  const content = el('div', {},
    el('p.bud-edit-sub', {},
      `Monthly limit for ${b.categoryName}${b.parentName ? ` (${b.parentName})` : ''}.`),
    el('div.form-row', {},
      el('div', {},
        el('label', { for: 'bud-edit-amount' }, 'Monthly amount'),
        amountInput,
        errLine,
      ),
    ),
    el('p.muted', {}, 'Stored to the cent; applies to this and every future month.'),
    el('div.dialog-actions', {},
      el('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      saveBtn,
    ),
  );

  const dlg = openDialog({
    title: `Edit budget \u2014 ${b.categoryName}`,
    content,
  });

  amountInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });
}

function eligibleCategories(categories, budgets) {
  const budgeted = new Set(budgets.map((b) => b.categoryId));
  const parents = new Set(
    categories.filter((c) => c.parentId != null).map((c) => c.parentId),
  );
  return categories
    .filter((c) => c.kind === 'expense' && !parents.has(c.id) && !budgeted.has(c.id))
    .map((c) => ({
      id: c.id,
      label: c.parentName ? `${c.name} (${c.parentName})` : c.name,
    }))
    .sort((a, b2) => a.label.localeCompare(b2.label));
}

function setBudgetPanel(categories, budgets, state) {
  const eligible = eligibleCategories(categories, budgets);
  const card = el('div.card.bud-form-panel');

  const catSelect = el('select', { id: 'bud-new-cat' },
    el('option', { value: '' }, 'Choose a category\u2026'),
    eligible.map((c) => el('option', { value: String(c.id) }, c.label)),
  );

  const amountInput = el('input', {
    type: 'text',
    placeholder: '250.00',
    inputmode: 'decimal',
    autocomplete: 'off',
    id: 'bud-new-amount',
    'aria-describedby': 'bud-new-error',
  });

  const errLine = el('div.field-error', { id: 'bud-new-error', hidden: true });

  function setErr(msg) {
    errLine.textContent = msg;
    errLine.hidden = false;
  }

  const saveBtn = el('button.btn.btn-primary', { type: 'button' }, 'Save budget');
  saveBtn.addEventListener('click', async () => {
    errLine.hidden = true;
    if (!catSelect.value) {
      setErr('Choose a category.');
      catSelect.focus();
      return;
    }
    const parsed = parseAmountToMinor(amountInput.value);
    if (parsed == null) {
      setErr('Enter an amount like 250 or 250.00 \u2014 two decimal places at most.');
      amountInput.focus();
      return;
    }
    if (parsed <= 0) {
      setErr('The monthly amount must be greater than zero.');
      amountInput.focus();
      return;
    }
    saveBtn.disabled = true;
    try {
      await api('/budgets', {
        method: 'PUT',
        body: { categoryId: Number(catSelect.value), monthlyAmountMinor: parsed },
      });
      toast(`Budget set for ${catSelect.selectedOptions[0].textContent}`, 'success');
      announce(`Budget set for ${catSelect.selectedOptions[0].textContent}`);
      draw(document.getElementById('view'), state);
    } catch (err) {
      setErr(err.message);
      saveBtn.disabled = false;
    }
  });

  card.append(el('h2', {}, 'Set a new budget'));
  card.append(el('p.muted', {},
    'Pick an expense category that has no budget yet. The limit applies per calendar month.'));
  card.append(el('div.form-row.bud-form-row', {},
    el('div', {}, el('label', { for: 'bud-new-cat' }, 'Category'), catSelect),
    el('div', {}, el('label', { for: 'bud-new-amount' }, 'Monthly amount'), amountInput),
    el('div', {}, saveBtn),
  ));
  card.append(errLine);

  if (!eligible.length) {
    catSelect.disabled = true;
    amountInput.disabled = true;
    saveBtn.disabled = true;
    card.append(el('p.muted.bud-form-exhausted', {},
      'Every expense category already has a budget. Edit an existing one below.'));
  }

  return card;
}

function parseAmountToMinor(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.startsWith('-')) return null;
  s = s.replace(/^[^0-9]+/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracRaw = dot === -1 ? '' : s.slice(dot + 1);
  if (fracRaw.length > 2) return null;
  const frac = (fracRaw + '00').slice(0, 2);
  const minor = Number(intPart) * 100 + Number(frac);
  return Number.isSafeInteger(minor) ? minor : null;
}

function minorToMajorString(minor) {
  const abs = Math.abs(minor);
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function monthLabel(key) {
  return `${MONTHS_FULL[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

function todayMonth() {
  return todayISO().slice(0, 7);
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function clampMonth(key, { min, max }) {
  if (key < min) return min;
  if (key > max) return max;
  return key;
}
