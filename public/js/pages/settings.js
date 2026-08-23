import {
  api, el, fmtMoney, toast, announce, openDialog, confirmDialog,
  getSettings, applyTheme, loadSettings,
} from '../lib.js';

const THEMES = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['high-contrast', 'High contrast'],
];

const ACCOUNT_TYPES = [
  ['checking', 'Checking'],
  ['savings', 'Savings'],
  ['credit', 'Credit card'],
  ['cash', 'Cash'],
];

export async function render(view) {
  ensureStyles();
  view.innerHTML = '';
  view.append(skeleton());

  let settings = getSettings();
  if (!settings) {
    try {
      settings = await loadSettings();
    } catch (err) {
      view.innerHTML = '';
      view.append(errorPanel(err));
      return;
    }
  }

  let meta;
  let balances;
  let categories;
  try {
    [meta, balances, categories] = await Promise.all([
      api('/meta'),
      api('/accounts/balances'),
      api('/categories'),
    ]);
  } catch (err) {
    view.innerHTML = '';
    view.append(errorPanel(err));
    return;
  }

  const root = el('div.set-page', {},
    el('div.page-head', {},
      el('h1', {}, 'Settings'),
      el('span.page-sub', {}, 'Make the ledger yours \u2014 everything stays on this machine'),
    ),
    appearanceCard(settings),
    displayCard(settings),
    accountsCard(balances),
    dataCard(meta),
    categoriesCard(categories),
  );

  view.innerHTML = '';
  view.append(root);
  announce('Settings loaded');
}

function ensureStyles() {
  if (document.querySelector('link[data-pages-css="settings"]')) return;
  document.head.append(el('link', {
    rel: 'stylesheet',
    href: '/css/pages.css',
    'data-pages-css': 'settings',
  }));
}

function skeleton() {
  const wrap = el('div.skeleton-wrap');
  for (let i = 0; i < 4; i += 1) wrap.append(el('div.skeleton-bar'));
  return wrap;
}

function errorPanel(err) {
  return el('div.error-panel', {}, `Could not load settings: ${err.message}`);
}

function appearanceCard(settings) {
  const card = el('div.card');
  card.append(el('h2', {}, 'Appearance'));

  let current = settings.theme;

  function makeRadio([value, label]) {
    const input = el('input', {
      type: 'radio',
      name: 'set-theme',
      value,
      id: `set-theme-${value}`,
      checked: current === value,
    });
    input.addEventListener('change', async () => {
      if (!input.checked || value === current) return;
      applyTheme(value);
      try {
        await api('/settings', { method: 'PUT', body: { theme: value } });
        current = value;
        announce(`${label} theme applied`);
      } catch (err) {
        applyTheme(current);
        syncChecked(current);
        toast(err.message, 'error');
      }
    });
    return el('label', { for: `set-theme-${value}` }, input, label);
  }

  function syncChecked(theme) {
    card.querySelectorAll('input[name="set-theme"]').forEach((r) => {
      r.checked = r.value === theme;
    });
  }

  card.append(el('div.set-radios', {}, THEMES.map(makeRadio)));
  card.append(el('p.muted', {}, 'Applied instantly and saved automatically.'));
  return card;
}

function displayCard(settings) {
  const d = settings.display ?? {};
  const card = el('div.card');
  card.append(el('h2', {}, 'Number display'));
  card.append(el('p.muted', {}, 'How amounts appear everywhere in Ledgerlight.'));

  const currencyInput = el('input', {
    type: 'text',
    id: 'set-currency',
    maxlength: '3',
    autocomplete: 'off',
    value: d.currency ?? 'USD',
  });

  const symbolInput = el('input', {
    type: 'text',
    id: 'set-symbol',
    maxlength: '3',
    autocomplete: 'off',
    value: d.symbol ?? '$',
  });

  function sideRadio(value, label) {
    const input = el('input', {
      type: 'radio',
      name: 'set-side',
      value,
      id: `set-side-${value}`,
      checked: (d.symbolSide ?? 'left') === value,
    });
    return el('label', { for: `set-side-${value}` }, input, label);
  }

  const groupInput = el('input', {
    type: 'text',
    id: 'set-group-sep',
    maxlength: '1',
    autocomplete: 'off',
    value: d.groupSeparator ?? ',',
  });
  const decInput = el('input', {
    type: 'text',
    id: 'set-dec-sep',
    maxlength: '1',
    autocomplete: 'off',
    value: d.decimalSeparator ?? '.',
  });
  const digitsSelect = el('select', { id: 'set-digits' },
    [0, 1, 2].map((n) =>
      el('option', { value: String(n), selected: (d.decimalDigits ?? 2) === n }, String(n))),
  );

  const errors = {
    currency: el('span.field-error', { hidden: true }),
    symbol: el('span.field-error', { hidden: true }),
    groupSeparator: el('span.field-error', { hidden: true }),
    decimalSeparator: el('span.field-error', { hidden: true }),
  };

  const previewNum = el('span.set-preview-num.num');
  const preview = el('div.set-preview', {}, el('strong', {}, 'Preview:'), previewNum);

  function candidateDisplay() {
    const side = card.querySelector('input[name="set-side"]:checked');
    return {
      currency: currencyInput.value.trim(),
      symbol: symbolInput.value,
      symbolSide: side ? side.value : 'left',
      groupSeparator: groupInput.value,
      decimalSeparator: decInput.value,
      decimalDigits: Number(digitsSelect.value),
    };
  }

  function updatePreview() {
    previewNum.textContent = previewMoney(candidateDisplay());
  }

  currencyInput.addEventListener('input', () => {
    currencyInput.value = currencyInput.value.toUpperCase().replace(/[^A-Z]/g, '');
    updatePreview();
  });
  for (const node of [symbolInput, groupInput, decInput]) {
    node.addEventListener('input', updatePreview);
  }
  card.addEventListener('change', (e) => {
    if (e.target.name === 'set-side' || e.target === digitsSelect) updatePreview();
  });

  function setFieldError(key, msg) {
    errors[key].textContent = msg ?? '';
    errors[key].hidden = !msg;
  }

  const saveBtn = el('button.btn.btn-primary', { type: 'button' }, 'Save number format');
  saveBtn.addEventListener('click', async () => {
    Object.keys(errors).forEach((k) => setFieldError(k, null));
    const candidate = candidateDisplay();
    let firstBad = null;
    if (!/^[A-Z]{3}$/.test(candidate.currency)) {
      setFieldError('currency', 'Three letters, e.g. USD.');
      firstBad = firstBad ?? currencyInput;
    }
    if (candidate.symbol.length < 1 || candidate.symbol.length > 3) {
      setFieldError('symbol', 'Use 1-3 characters.');
      firstBad = firstBad ?? symbolInput;
    }
    if (candidate.groupSeparator.length !== 1) {
      setFieldError('groupSeparator', 'Exactly one character.');
      firstBad = firstBad ?? groupInput;
    }
    if (candidate.decimalSeparator.length !== 1) {
      setFieldError('decimalSeparator', 'Exactly one character.');
      firstBad = firstBad ?? decInput;
    }
    if (firstBad) {
      firstBad.focus();
      return;
    }
    saveBtn.disabled = true;
    try {
      const saved = await api('/settings', { method: 'PUT', body: { display: candidate } });
      const live = getSettings();
      if (live) {
        live.theme = saved.theme;
        live.display = saved.display;
      }
      toast('Number format saved', 'success');
      announce('Number format saved');
      updatePreview();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  card.append(el('div.set-field-grid', {},
    field('Currency code', currencyInput, errors.currency),
    field('Symbol', symbolInput, errors.symbol),
    el('div.set-field', {},
      el('label', {}, 'Symbol side'),
      el('div.set-radios', {}, sideRadio('left', 'Left'), sideRadio('right', 'Right')),
    ),
    field('Thousands separator', groupInput, errors.groupSeparator),
    field('Decimal separator', decInput, errors.decimalSeparator),
    el('div.set-field', {},
      el('label', { for: 'set-digits' }, 'Decimal digits'),
      digitsSelect,
    ),
  ));
  card.append(preview);
  card.append(el('div.form-row', {}, el('div', {}, saveBtn)));
  updatePreview();
  return card;
}

function field(labelText, control, errorNode) {
  return el('div.set-field', {},
    el('label', { for: control.id }, labelText),
    control,
    errorNode,
  );
}

function previewMoney(display) {
  const live = getSettings();
  if (!live || !live.display) return manualMoney(display);
  const saved = { ...live.display };
  Object.assign(live.display, display);
  try {
    return fmtMoney(-123456);
  } finally {
    Object.assign(live.display, saved);
  }
}

function manualMoney(d) {
  const symbol = d.symbol ?? '$';
  const side = d.symbolSide ?? 'left';
  const group = d.groupSeparator ?? ',';
  const dec = d.decimalSeparator ?? '.';
  const digits = d.decimalDigits ?? 2;
  const abs = Math.abs(-123456);
  const div = 10 ** digits;
  const intPart = String(Math.floor(abs / div));
  const fracPart = String(abs % div).padStart(digits, '0');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const num = digits > 0 ? `${grouped}${dec}${fracPart}` : grouped;
  const body = side === 'left' ? `${symbol} ${num}` : `${num} ${symbol}`;
  return `(${body})`;
}

function accountsCard(balances) {
  const card = el('div.card');
  card.append(el('h2', {}, 'Accounts'));

  const tbody = el('tbody');

  function renderRows(rows) {
    tbody.replaceChildren(
      ...(rows ?? []).map((a) => el('tr', {},
        el('td', {}, el('strong', {}, a.name)),
        el('td', {}, cap(a.type)),
        el('td.muted', {}, a.currency),
        el('td.num', {}, fmtMoney(a.opening_balance_minor)),
        el('td.num' + (a.balanceMinor < 0 ? '.amount-neg' : ''), {}, fmtMoney(a.balanceMinor)),
        el('td.num', {}, String(a.txnCount)),
        el('td.set-actions-cell', {},
          el('button.btn.btn-sm', { type: 'button', onclick: () => editAccount(a) }, 'Edit'),
          el('button.btn.btn-sm.btn-danger', { type: 'button', onclick: () => removeAccount(a) }, 'Delete'),
        ),
      )),
    );
    if (!rows || !rows.length) {
      tbody.append(el('tr', {}, el('td', { colspan: '7' },
        'No accounts yet. Add one below or import a CSV.')));
    }
  }

  async function refresh() {
    try {
      const rows = await api('/accounts/balances');
      renderRows(rows);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function editAccount(a) {
    const nameInput = el('input', {
      type: 'text', id: 'set-acct-name', value: a.name, maxlength: '80', autocomplete: 'off',
    });
    const openInput = el('input', {
      type: 'text', id: 'set-acct-open', value: signedMajor(a.opening_balance_minor),
      inputmode: 'decimal', autocomplete: 'off',
    });
    const errLine = el('div.field-error', { id: 'set-acct-error', hidden: true });
    const saveBtn = el('button.btn.btn-primary', { type: 'button' }, 'Save changes');
    saveBtn.addEventListener('click', async () => {
      errLine.hidden = true;
      const name = nameInput.value.trim();
      const opening = parseAmountToMinor(openInput.value, { signed: true, blankIsZero: true });
      if (!name) {
        errLine.textContent = 'Name is required.';
        errLine.hidden = false;
        nameInput.focus();
        return;
      }
      if (opening == null) {
        errLine.textContent = 'Opening balance must look like 100, -45.50 or (45.50).';
        errLine.hidden = false;
        openInput.focus();
        return;
      }
      saveBtn.disabled = true;
      try {
        await api(`/accounts/${a.id}`, {
          method: 'PATCH',
          body: { name, openingBalanceMinor: opening },
        });
        dlg.close();
        toast(`Account "${name}" updated`, 'success');
        announce(`Account ${name} updated`);
        refresh();
      } catch (err) {
        errLine.textContent = err.message;
        errLine.hidden = false;
        saveBtn.disabled = false;
      }
    });
    const content = el('div', {},
      el('p.muted', {}, `Type stays ${cap(a.type)}; currency stays ${a.currency}.`),
      el('div.form-row', {},
        el('div', {}, el('label', { for: 'set-acct-name' }, 'Name'), nameInput),
        el('div', {}, el('label', { for: 'set-acct-open' }, 'Opening balance'), openInput),
      ),
      errLine,
      el('div.dialog-actions', {},
        el('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
        saveBtn,
      ),
    );
    const dlg = openDialog({ title: `Edit account \u2014 ${a.name}`, content });
  }

  async function removeAccount(a) {
    const noun = a.txnCount === 1 ? 'transaction' : 'transactions';
    const ok = await confirmDialog({
      title: 'Delete account',
      message: `Delete "${a.name}" and its ${a.txnCount} ${noun}? This cannot be undone.`,
      confirmLabel: 'Delete account',
    });
    if (!ok) return;
    try {
      await api(`/accounts/${a.id}`, { method: 'DELETE' });
      toast(`Account "${a.name}" deleted`, 'success');
      announce(`Account ${a.name} deleted`);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const addName = el('input', { type: 'text', id: 'set-add-name', maxlength: '80', autocomplete: 'off', placeholder: 'Checking' });
  const addType = el('select', { id: 'set-add-type' },
    ACCOUNT_TYPES.map(([v, l]) => el('option', { value: v }, l)));
  const addCurrency = el('input', { type: 'text', id: 'set-add-currency', maxlength: '3', autocomplete: 'off', value: 'USD' });
  const addOpen = el('input', { type: 'text', id: 'set-add-open', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' });
  const addErr = el('div.field-error', { id: 'set-add-error', hidden: true });
  const addBtn = el('button.btn.btn-primary', { type: 'button' }, 'Add account');

  addCurrency.addEventListener('input', () => {
    addCurrency.value = addCurrency.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  addBtn.addEventListener('click', async () => {
    addErr.hidden = true;
    const name = addName.value.trim();
    if (!name) {
      addErr.textContent = 'Name is required.';
      addErr.hidden = false;
      addName.focus();
      return;
    }
    if (!/^[A-Z]{3}$/.test(addCurrency.value)) {
      addErr.textContent = 'Currency needs three letters, e.g. USD.';
      addErr.hidden = false;
      addCurrency.focus();
      return;
    }
    const opening = parseAmountToMinor(addOpen.value, { signed: true, blankIsZero: true });
    if (opening == null) {
      addErr.textContent = 'Opening balance must look like 100, -45.50 or (45.50).';
      addErr.hidden = false;
      addOpen.focus();
      return;
    }
    addBtn.disabled = true;
    try {
      await api('/accounts', {
        method: 'POST',
        body: { name, type: addType.value, currency: addCurrency.value, openingBalanceMinor: opening },
      });
      toast(`Account "${name}" added`, 'success');
      announce(`Account ${name} added`);
      addName.value = '';
      addOpen.value = '';
      refresh();
    } catch (err) {
      addErr.textContent = err.message;
      addErr.hidden = false;
    } finally {
      addBtn.disabled = false;
    }
  });

  renderRows(balances);

  card.append(el('div.bud-scroll', {},
    el('table.set-table', {},
      el('caption', {}, 'Accounts with balances and transaction counts'),
      el('thead', {}, el('tr', {},
        thCol('Account'), thCol('Type'), thCol('Currency'),
        thCol('Opening balance', true), thCol('Balance', true), thCol('Txns', true), thCol('Actions'),
      )),
      tbody,
    ),
  ));
  card.append(el('div.set-add-form', {},
    el('h3', {}, 'Add account'),
    el('div.form-row', {},
      el('div', {}, el('label', { for: 'set-add-name' }, 'Name'), addName),
      el('div', {}, el('label', { for: 'set-add-type' }, 'Type'), addType),
      el('div', {}, el('label', { for: 'set-add-currency' }, 'Currency'), addCurrency),
      el('div', {}, el('label', { for: 'set-add-open' }, 'Opening balance'), addOpen),
      el('div', {}, addBtn),
    ),
    addErr,
  ));
  return card;
}

function dataCard(meta) {
  const card = el('div.card');
  card.append(el('h2', {}, 'Data'));

  const backupBtn = el('button.btn', { type: 'button' }, 'Download full backup');
  backupBtn.addEventListener('click', async () => {
    backupBtn.disabled = true;
    try {
      const backup = await api('/backup');
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = el('a', { href: url, download: 'ledgerlight-backup.json' });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Backup downloaded', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      backupBtn.disabled = false;
    }
  });

  const fileInput = el('input', {
    type: 'file',
    accept: '.json,application/json',
    id: 'set-restore-file',
  });
  const restoreBtn = el('button.btn.btn-danger', { type: 'button', disabled: true }, 'Restore backup');
  const restoreErr = el('div.set-error', { role: 'alert', hidden: true });
  fileInput.addEventListener('change', () => {
    restoreBtn.disabled = !(fileInput.files && fileInput.files.length);
  });

  restoreBtn.addEventListener('click', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    restoreErr.hidden = true;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      restoreErr.textContent = `Could not read backup file: ${err.message}`;
      restoreErr.hidden = false;
      return;
    }
    const ok = await confirmDialog({
      title: 'Restore backup',
      message: 'This replaces ALL current data with the contents of the backup file.',
      confirmLabel: 'Replace all data',
    });
    if (!ok) return;
    restoreBtn.disabled = true;
    try {
      const res = await api('/restore', { method: 'POST', body: parsed });
      const counts = res.restored ?? {};
      const parts = Object.entries(counts).map(([table, n]) => `${n} ${table}`);
      toast(`Restored: ${parts.join(', ')}`, 'success');
      announce('Backup restored');
      fileInput.value = '';
      restoreBtn.disabled = true;
      await loadSettings().catch(() => {});
      render(document.getElementById('view'));
    } catch (err) {
      restoreErr.textContent = [
        err.code ? `${err.code}: ` : '',
        err.message,
        err.details != null ? ` ${JSON.stringify(err.details)}` : '',
      ].join('');
      restoreErr.hidden = false;
      restoreBtn.disabled = false;
    }
  });

  card.append(el('div.set-btn-row', {},
    el('a.btn', { href: '/api/export.csv', download: 'ledgerlight-transactions.csv' }, 'Export CSV'),
    el('a.btn', { href: '/api/export.json', download: 'ledgerlight-transactions.json' }, 'Export JSON'),
    backupBtn,
  ));

  card.append(el('div.set-restore', {},
    el('h3', {}, 'Restore backup'),
    el('p.muted', {}, 'Restoring replaces every table with the contents of the backup file.'),
    el('div.form-row', {},
      el('div', {}, el('label', { for: 'set-restore-file' }, 'Backup file (.json)'), fileInput),
      el('div', {}, restoreBtn),
    ),
    restoreErr,
  ));

  card.append(el('div.set-meta', {},
    el('p', {},
      el('strong', {}, 'Database file: '),
      el('span.set-mono', {}, meta.dbPath),
    ),
    el('p.muted', {}, 'All data stays on this machine.'),
  ));
  return card;
}

function categoriesCard(categories) {
  const card = el('div.card');
  card.append(el('h2', {}, 'Categories'));
  card.append(el('p.muted', {},
    'The taxonomy is fixed \u2014 groups hold related kinds, leaves collect transactions. Read-only except for additions.'));

  const tree = el('ul.set-tree');
  let parentSelect;

  function renderTree(cats) {
    const groups = cats.filter((c) => c.kind === 'group');
    const kidsOf = new Map(groups.map((g) => [g.id, cats.filter((c) => c.parentId === g.id)]));
    const loose = cats.filter((c) => c.kind !== 'group' && c.parentId == null);

    tree.replaceChildren(...groups.map((g) => el('li', {},
      el('div.set-tree-row', {},
        el('strong', {}, g.name),
        el('span.set-chips', {}, kindChip('group')),
      ),
      kidsOf.get(g.id)?.length
        ? el('ul.set-tree-kids', {}, kidsOf.get(g.id).map((c) => leafRow(c)))
        : null,
    )));

    if (loose.length) {
      tree.append(el('li', {},
        el('div.set-tree-row', {},
          el('strong.muted', {}, 'Ungrouped'),
          el('span.muted', {}, String(loose.length)),
        ),
        el('ul.set-tree-kids', {}, loose.map((c) => leafRow(c))),
      ));
    }
  }

  function leafRow(c) {
    const chips = [kindChip(c.kind)];
    if (c.excludeFromSpend) chips.push(el('span.chip.chip-warn', {}, '! Excluded from spend'));
    return el('li.set-tree-child', {},
      el('span', {}, c.name),
      el('span.set-chips', {}, chips),
    );
  }

  function kindChip(kind) {
    if (kind === 'income') return el('span.chip.chip-pos', {}, 'income');
    if (kind === 'group') return el('span.chip', {}, 'group');
    return el('span.chip', {}, 'expense');
  }

  const addName = el('input', { type: 'text', id: 'set-cat-name', maxlength: '60', autocomplete: 'off', placeholder: 'Pets' });
  parentSelect = el('select', { id: 'set-cat-parent' });
  const kindSelect = el('select', { id: 'set-cat-kind' },
    el('option', { value: 'expense' }, 'Expense'),
    el('option', { value: 'income' }, 'Income'),
  );
  const addErr = el('div.field-error', { id: 'set-cat-error', hidden: true });
  const addBtn = el('button.btn', { type: 'button' }, 'Add category');

  function fillParentSelect(cats) {
    const groups = cats.filter((c) => c.kind === 'group');
    parentSelect.replaceChildren(
      el('option', { value: '' }, 'No group'),
      ...groups.map((g) => el('option', { value: String(g.id) }, g.name)),
    );
  }

  async function refresh() {
    try {
      const cats = await api('/categories');
      fillParentSelect(cats);
      renderTree(cats);
      return cats;
    } catch (err) {
      toast(err.message, 'error');
      return [];
    }
  }

  addBtn.addEventListener('click', async () => {
    addErr.hidden = true;
    const name = addName.value.trim();
    if (!name) {
      addErr.textContent = 'Name is required.';
      addErr.hidden = false;
      addName.focus();
      return;
    }
    const body = { name, kind: kindSelect.value };
    if (parentSelect.value) body.parentId = Number(parentSelect.value);
    addBtn.disabled = true;
    try {
      await api('/categories', { method: 'POST', body });
      toast(`Category "${name}" added`, 'success');
      announce(`Category ${name} added`);
      addName.value = '';
      await refresh();
    } catch (err) {
      addErr.textContent = err.message;
      addErr.hidden = false;
    } finally {
      addBtn.disabled = false;
    }
  });

  fillParentSelect(categories);
  renderTree(categories);

  card.append(tree);
  card.append(el('div.set-add-form', {},
    el('h3', {}, 'Add category'),
    el('div.form-row', {},
      el('div', {}, el('label', { for: 'set-cat-name' }, 'Name'), addName),
      el('div', {}, el('label', { for: 'set-cat-parent' }, 'Group'), parentSelect),
      el('div', {}, el('label', { for: 'set-cat-kind' }, 'Kind'), kindSelect),
      el('div', {}, addBtn),
    ),
    addErr,
  ));
  return card;
}

function thCol(text, isNum) {
  return el('th' + (isNum ? '.num' : ''), { scope: 'col' }, text);
}

function cap(word) {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

function signedMajor(minor) {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function parseAmountToMinor(raw, { signed = false, blankIsZero = false } = {}) {
  let s = String(raw ?? '').trim();
  if (!s) return blankIsZero ? 0 : null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    neg = true;
    s = s.slice(1, -1).trim();
  } else if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  s = s.replace(/^[^0-9]+/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracRaw = dot === -1 ? '' : s.slice(dot + 1);
  if (fracRaw.length > 2) return null;
  const frac = (fracRaw + '00').slice(0, 2);
  const minor = Number(intPart) * 100 + Number(frac);
  if (!Number.isSafeInteger(minor)) return null;
  if (!signed && neg) return null;
  return neg ? -minor : minor;
}
