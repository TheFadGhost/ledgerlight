// Rules page — manage auto-categorization rules (user + learned), with a
// live tester. Vanilla ES modules; all IO through lib.js helpers.

import {
  api,
  el,
  fmtMoney,
  fmtDate,
  toast,
  announce,
  openDialog,
  confirmDialog,
} from '../lib.js';

export async function render(view) {
  ensureStyles();
  view.innerHTML = '';
  view.append(skeleton());
  let rules;
  try {
    rules = await api('/rules');
  } catch (err) {
    view.innerHTML = '';
    view.append(el('div.error-panel', {}, `Could not load rules: ${err.message}`));
    return;
  }
  const page = buildPage(rules, () => redraw(view));
  view.innerHTML = '';
  view.append(page);
  announce(`${rules.length} rules, evaluated top to bottom`);
}

async function redraw(view) {
  let rules;
  try {
    rules = await api('/rules');
  } catch (err) {
    view.innerHTML = '';
    view.append(el('div.error-panel', {}, `Could not load rules: ${err.message}`));
    return;
  }
  const page = buildPage(rules, () => redraw(view));
  view.innerHTML = '';
  view.append(page);
}

function ensureStyles() {
  if (document.querySelector('link[data-pages-css="rules"]')) return;
  document.head.append(el('link', {
    rel: 'stylesheet',
    href: '/css/pages.css',
    'data-pages-css': 'rules',
  }));
}

function skeleton() {
  const wrap = el('div.skeleton-wrap');
  for (let i = 0; i < 4; i += 1) wrap.append(el('div.skeleton-bar'));
  return wrap;
}

/* ---- page assembly ----------------------------------------------------- */

function buildPage(rules, refresh) {
  return el('div.rl-page', {},
    el('div.page-head', {},
      el('h1', {}, 'Auto-categorization rules'),
      el('span.page-sub', {}, 'Send matching transactions to a category automatically'),
      el('button.btn.btn-primary.head-action', {
        type: 'button',
        onclick: () => openRuleDialog(null, refresh),
      }, 'New rule'),
    ),
    explainCard(),
    rules.length === 0 ? emptyState(refresh) : tableCard(rules, refresh),
  );
}

function explainCard() {
  return el('div.rl-note.card', {},
    el('p', {},
      'Rules are evaluated top to bottom: learned rules always take precedence over your own. ',
      'A learned rule is recorded automatically whenever you correct a transaction\u2019s category. ',
      'To remove one, delete its row below \u2014 or untick Enabled to keep it without using it.',
    ),
  );
}

function emptyState(refresh) {
  return el('div.card', {},
    el('div.empty-state', {},
      el('p', {}, 'No rules yet. Transactions stay Uncategorized until a rule matches.'),
      el('button.btn.btn-primary', {
        type: 'button',
        onclick: () => openRuleDialog(null, refresh),
      }, 'Create your first rule'),
    ),
  );
}

function tableCard(rules, refresh) {
  let userSeen = 0;
  const userTotal = rules.filter((r) => r.source === 'user').length;
  const rows = rules.map((rule, i) => {
    const ctx = {
      position: i + 1,
      userIndex: rule.source === 'user' ? userSeen++ : -1,
      userTotal,
    };
    return ruleRow(rule, ctx, refresh);
  });
  return el('div.card.rl-card', {},
    el('table.rl-table', {},
      el('caption', {}, 'Rules evaluated top to bottom'),
      el('thead', {}, el('tr', {},
        th('#'),
        th('Name'),
        th('Match'),
        th('Target category'),
        th('Scope'),
        th('Source'),
        el('th.rl-center', { scope: 'col' }, 'Enabled'),
        el('th.rl-actions', { scope: 'col' }, 'Actions'),
      )),
      el('tbody', {}, rows),
    ),
  );
}

function th(text) {
  return el('th', { scope: 'col' }, text);
}

function ruleRow(rule, ctx, refresh) {
  const learned = rule.source === 'learned';

  const enabledBox = el('input', {
    type: 'checkbox',
    checked: !!rule.enabled,
    'aria-label': `Enable rule ${rule.name}`,
  });
  enabledBox.addEventListener('change', async () => {
    enabledBox.disabled = true;
    try {
      await api(`/rules/${rule.id}`, { method: 'PATCH', body: { enabled: enabledBox.checked } });
      toast(`Rule "${rule.name}" ${enabledBox.checked ? 'enabled' : 'disabled'}`, 'success');
      announce(`Rule ${rule.name} ${enabledBox.checked ? 'enabled' : 'disabled'}`);
    } catch (err) {
      enabledBox.checked = !enabledBox.checked;
      toast(err.message, 'error');
    } finally {
      enabledBox.disabled = false;
    }
  });

  const actions = el('td.rl-actions', {});
  if (!learned) {
    const up = el('button.btn.btn-sm.rl-move', {
      type: 'button',
      disabled: ctx.userIndex <= 0,
      'aria-label': `Move rule ${rule.name} up`,
      title: 'Move up',
    }, '\u2191');
    const down = el('button.btn.btn-sm.rl-move', {
      type: 'button',
      disabled: ctx.userIndex >= ctx.userTotal - 1,
      'aria-label': `Move rule ${rule.name} down`,
      title: 'Move down',
    }, '\u2193');
    const onMove = (dir) => async () => {
      up.disabled = down.disabled = true;
      try {
        await moveRule(rule.id, dir);
      } catch (err) {
        toast(err.message, 'error');
        up.disabled = down.disabled = false;
      }
    };
    up.addEventListener('click', onMove(-1));
    down.addEventListener('click', onMove(1));
    actions.append(up, down);
    actions.append(el('button.btn.btn-sm', {
      type: 'button',
      onclick: () => openRuleDialog(rule, refresh),
    }, 'Edit'));
  }
  actions.append(el('button.btn.btn-sm.btn-danger', {
    type: 'button',
    onclick: () => deleteRule(rule, refresh),
  }, 'Delete'));

  return el('tr', {},
    el('td.num.rl-order', {}, String(ctx.position)),
    el('td.rl-name-cell', {},
      rule.name,
      learned ? el('span.rl-learned-note', {}, 'Learned from your corrections') : null,
    ),
    el('td.rl-match-cell', {}, matchText(rule)),
    el('td', {}, el('span.chip', { title: categoryPath(rule) }, categoryPath(rule))),
    el('td', {}, rule.accountName ?? 'All'),
    el('td', {}, el('span.chip', { class: `chip${learned ? ' chip-warn' : ''}` }, learned ? 'Learned' : 'User')),
    el('td.rl-center', {}, enabledBox),
    actions,
  );
}

/* ---- helpers ------------------------------------------------------------ */

function categoryPath(rule) {
  if (rule.categoryName == null) return '\u2014';
  return rule.parentCategoryName
    ? `${rule.parentCategoryName} \u203A ${rule.categoryName}`
    : rule.categoryName;
}

function matchText(rule) {
  switch (rule.matchType) {
    case 'substring':
      return `contains "${rule.pattern ?? ''}"`;
    case 'regex':
      return `matches /${rule.pattern ?? ''}/`;
    case 'amount_range': {
      const min = rule.minAmountMinor;
      const max = rule.maxAmountMinor;
      if (min != null && max != null) return `${fmtMoney(min)} to ${fmtMoney(max)}`;
      if (min != null) return `${fmtMoney(min)} and up`;
      if (max != null) return `up to ${fmtMoney(max)}`;
      return 'Any amount';
    }
    default:
      return 'Any transaction';
  }
}

/**
 * Reorder user rules by swapping the moved rule with its neighbour, then
 * renumbering priorities top-to-bottom in multiples of 10. Only rows whose
 * priority actually changed get a PATCH.
 */
async function moveRule(ruleId, dir) {
  const rules = await api('/rules');
  const users = rules.filter((r) => r.source === 'user');
  const i = users.findIndex((r) => r.id === ruleId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= users.length) return;
  const moved = users[i];
  [users[i], users[j]] = [users[j], users[i]];
  const patches = [];
  users.forEach((u, idx) => {
    const target = (idx + 1) * 10;
    if (u.priority !== target) patches.push(api(`/rules/${u.id}`, { method: 'PATCH', body: { priority: target } }));
  });
  await Promise.all(patches);
  toast(`Moved "${moved.name}" ${dir < 0 ? 'up' : 'down'}`, 'success');
  announce(`Moved ${moved.name} ${dir < 0 ? 'up' : 'down'}`);
}

async function deleteRule(rule, refresh) {
  const ok = await confirmDialog({
    title: 'Delete rule',
    message: `Delete rule "${rule.name}"? Transactions it already categorized keep their category.`,
    confirmLabel: 'Delete rule',
  });
  if (!ok) return;
  try {
    await api(`/rules/${rule.id}`, { method: 'DELETE' });
    toast(`Rule "${rule.name}" deleted`, 'success');
    announce(`Rule ${rule.name} deleted`);
    refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---- exact major\u2194minor string math (no floats) ------------------------- */

/** Major-unit string -> integer minor units. null when blank, undefined when invalid. */
function parseMajorToMinor(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  let t = s;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[\s,$]/g, '');
  if (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
  else if (t.startsWith('+')) t = t.slice(1);
  if (!/\d/.test(t) || !/^\d*(?:\.\d*)?$/.test(t)) return undefined;
  const [ipRaw, fpRaw = ''] = t.split('.');
  const ip = ipRaw.replace(/^0+(?=\d)/, '') || '0';
  if (ip.length > 13) return undefined;
  let cents;
  if (fpRaw.length <= 2) cents = BigInt(fpRaw.padEnd(2, '0'));
  else {
    cents = BigInt(fpRaw.slice(0, 2));
    if (Number(fpRaw[2]) >= 5) cents += 1n; // round half away from zero
  }
  const total = BigInt(ip) * 100n + cents;
  if (total > 9007199254740991n) return undefined;
  return neg ? -Number(total) : Number(total);
}

/** Integer minor units -> major-unit string for prefilling inputs. */
function minorToMajorString(minor) {
  if (minor == null) return '';
  const abs = Math.abs(minor);
  const sign = minor < 0 ? '-' : '';
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/* ---- new/edit dialog ---------------------------------------------------- */

const MATCH_TYPES = [
  ['substring', 'Substring'],
  ['regex', 'Regex'],
  ['amount_range', 'Amount range'],
  ['any', 'Any'],
];

async function openRuleDialog(rule, refresh) {
  let categories;
  let accounts;
  try {
    [categories, accounts] = await Promise.all([api('/categories'), api('/accounts')]);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  /* fields */
  const nameInput = el('input', {
    type: 'text',
    id: 'rl-name',
    maxlength: '80',
    autocomplete: 'off',
    value: rule?.name ?? '',
    placeholder: 'e.g. Coffee shops',
  });

  const radios = [];
  const radioRow = el('div.rl-radios', {});
  const currentType = rule?.matchType ?? 'substring';
  for (const [value, label] of MATCH_TYPES) {
    const input = el('input', {
      type: 'radio',
      name: 'rl-match-type',
      value,
      checked: value === currentType,
    });
    input.addEventListener('change', syncMatchUi);
    radios.push(input);
    radioRow.append(el('label', {}, input, label));
  }
  const matchTypeValue = () => radios.find((r) => r.checked)?.value ?? 'substring';

  const patternInput = el('input', {
    type: 'text',
    id: 'rl-pattern',
    autocomplete: 'off',
    spellcheck: 'false',
    value: rule?.pattern ?? '',
    placeholder: currentType === 'regex' ? '^netflix' : 'e.g. coffee',
  });

  const minInput = el('input', {
    type: 'number',
    id: 'rl-min',
    step: '0.01',
    autocomplete: 'off',
    value: minorToMajorString(rule?.minAmountMinor),
    placeholder: '-29.99',
    'aria-label': 'Minimum amount',
  });
  const maxInput = el('input', {
    type: 'number',
    id: 'rl-max',
    step: '0.01',
    autocomplete: 'off',
    value: minorToMajorString(rule?.maxAmountMinor),
    placeholder: '-4.00',
    'aria-label': 'Maximum amount',
  });

  const accountSel = el('select', { id: 'rl-account' },
    el('option', { value: '' }, 'All accounts'),
    accounts.map((a) => el('option', { value: String(a.id) }, a.name)),
  );
  if (rule?.accountId != null) accountSel.value = String(rule.accountId);

  const catGroups = new Map();
  const loose = [];
  for (const c of categories) {
    if (c.kind === 'group') catGroups.set(c.id, { label: c.name, leaves: [] });
  }
  for (const c of categories) {
    if (c.kind === 'group') continue;
    const g = c.parentId != null ? catGroups.get(c.parentId) : null;
    if (g) g.leaves.push(c);
    else loose.push(c);
  }
  const catParts = [el('option', { value: '' }, 'Choose a category\u2026')];
  for (const g of catGroups.values()) {
    if (!g.leaves.length) continue;
    catParts.push(el('optgroup', { label: g.label },
      g.leaves.map((c) => el('option', { value: String(c.id) }, c.name))));
  }
  if (loose.length) {
    catParts.push(el('optgroup', { label: 'Other' },
      loose.map((c) => el('option', { value: String(c.id) }, c.name))));
  }
  const catSel = el('select', { id: 'rl-category', required: true }, catParts);
  if (rule?.categoryId != null) catSel.value = String(rule.categoryId);

  /* errors */
  const patternErr = el('div.field-error', { hidden: true });
  const amtErr = el('div.field-error', { hidden: true });
  const catErr = el('div.field-error', { hidden: true });
  const acctErr = el('div.field-error', { hidden: true });
  const genErr = el('div.field-error', { hidden: true });

  function clearErrors() {
    for (const n of [patternErr, amtErr, catErr, acctErr, genErr]) {
      n.textContent = '';
      n.hidden = true;
    }
  }

  /** Route an error (typically RuleValidationError) verbatim under its field. */
  function placeError(err) {
    const msg = err.message || 'Request failed';
    const text = err.code === 'LEARNED_IMMUTABLE'
      ? 'Learned rules can only be enabled/disabled or deleted.' : msg;
    if (/pattern|regex/i.test(msg)) { patternErr.textContent = text; patternErr.hidden = false; }
    else if (/amount/i.test(msg)) { amtErr.textContent = text; amtErr.hidden = false; }
    else if (/category/i.test(msg)) { catErr.textContent = text; catErr.hidden = false; }
    else if (/account/i.test(msg)) { acctErr.textContent = text; acctErr.hidden = false; }
    else { genErr.textContent = text; genErr.hidden = false; }
  }

  /* visibility per match type */
  const patternLabel = el('label', { for: 'rl-pattern' },
    currentType === 'regex' ? 'Pattern (regular expression)' : 'Pattern (text to find)');
  const patternRow = el('div.form-row', {},
    el('div', {}, patternLabel, patternInput, patternErr),
  );
  const amountRow = el('div.rl-range', {},
    el('div', {}, el('label', { for: 'rl-min' }, 'Min amount'), minInput),
    el('div', {}, el('label', { for: 'rl-max' }, 'Max amount'), maxInput),
    amtErr,
  );
  function syncMatchUi() {
    const mt = matchTypeValue();
    const showPattern = mt === 'substring' || mt === 'regex';
    const showAmount = mt === 'amount_range';
    patternLabel.textContent = mt === 'regex'
      ? 'Pattern (regular expression)' : 'Pattern (text to find)';
    patternRow.hidden = !showPattern;
    amountRow.hidden = !showAmount;
    patternInput.disabled = !showPattern;
    minInput.disabled = maxInput.disabled = !showAmount;
    if (!showAmount) { amtErr.hidden = true; }
    if (!showPattern) { patternErr.hidden = true; }
  }

  /* tester */
  const testBtn = el('button.btn', { type: 'button' }, 'Test against my transactions');
  const testResult = el('div.rl-test-result', { hidden: true });
  const tester = el('div.rl-tester', {},
    el('h3', {}, 'Test before saving'),
    el('p.muted', {}, 'Preview which of your transactions this draft would match. Nothing is saved.'),
    testBtn,
    testResult,
  );

  function renderTestResult(res) {
    testResult.replaceChildren(
      el('p.rl-test-count', {},
        `${res.matchedCount} matching transaction${res.matchedCount === 1 ? '' : 's'}`),
      res.samples.length
        ? el('table.rl-test-table', {},
            el('thead', {}, el('tr', {},
              el('th', { scope: 'col' }, 'Date'),
              el('th', { scope: 'col' }, 'Payee'),
              el('th', { scope: 'col' }, 'Amount'))),
            el('tbody', {},
              res.samples.slice(0, 10).map((s) => el('tr', {},
                el('td', {}, fmtDate(s.date)),
                el('td.rl-test-payee', { title: s.payee }, s.payee),
                el('td.num', { class: `num${s.amountMinor < 0 ? ' amount-neg' : ''}` }, fmtMoney(s.amountMinor)),
              ))))
        : el('p.muted', {}, 'No sample rows.'),
      res.matchedCount > 10
        ? el('p.rl-test-more.muted', {},
            `Showing first 10 of ${res.matchedCount}.`)
        : null,
    );
    testResult.hidden = false;
  }

  /** Collect the dialog into an API draft; returns {ok,draft} or {ok:false}. */
  function buildDraft() {
    const matchType = matchTypeValue();
    const draft = {
      matchType,
      pattern: null,
      minAmountMinor: null,
      maxAmountMinor: null,
      accountId: accountSel.value === '' ? null : Number(accountSel.value),
      categoryId: catSel.value === '' ? NaN : Number(catSel.value),
      name: nameInput.value.trim(),
    };
    if (matchType === 'substring' || matchType === 'regex') {
      const p = patternInput.value;
      if (p.length === 0) {
        patternErr.textContent = `${matchType} pattern must not be empty`;
        patternErr.hidden = false;
        patternInput.focus();
        return { ok: false };
      }
      draft.pattern = p;
    } else if (matchType === 'amount_range') {
      const min = parseMajorToMinor(minInput.value);
      const max = parseMajorToMinor(maxInput.value);
      if (min === undefined || max === undefined) {
        amtErr.textContent = 'Enter amounts as numbers in major units, e.g. -29.99';
        amtErr.hidden = false;
        (min === undefined ? minInput : maxInput).focus();
        return { ok: false };
      }
      if (min == null && max == null) {
        amtErr.textContent = 'amount_range requires at least one of min/max';
        amtErr.hidden = false;
        minInput.focus();
        return { ok: false };
      }
      if (min != null && max != null && min > max) {
        amtErr.textContent = `Min (${min}) must be <= Max (${max})`;
        amtErr.hidden = false;
        minInput.focus();
        return { ok: false };
      }
      draft.minAmountMinor = min;
      draft.maxAmountMinor = max;
    }
    if (!Number.isInteger(draft.categoryId)) {
      catErr.textContent = 'Choose a target category.';
      catErr.hidden = false;
      catSel.focus();
      return { ok: false };
    }
    return { ok: true, draft };
  }

  testBtn.addEventListener('click', async () => {
    clearErrors();
    const built = buildDraft();
    if (!built.ok) { testResult.hidden = true; return; }
    testBtn.disabled = true;
    testResult.replaceChildren(el('p.muted', {}, 'Testing\u2026'));
    testResult.hidden = false;
    try {
      const res = await api('/rules/test', { method: 'POST', body: built.draft });
      renderTestResult(res);
      announce(`${res.matchedCount} transactions match this rule draft`);
    } catch (err) {
      testResult.hidden = true;
      placeError(err);
    } finally {
      testBtn.disabled = false;
    }
  });

  /* save */
  const saveBtn = el('button.btn.btn-primary', { type: 'button' },
    rule ? 'Save changes' : 'Create rule');
  saveBtn.addEventListener('click', async () => {
    clearErrors();
    const built = buildDraft();
    if (!built.ok) return;
    saveBtn.disabled = true;
    try {
      if (rule) {
        await api(`/rules/${rule.id}`, { method: 'PATCH', body: built.draft });
        toast(`Rule "${built.draft.name || rule.name}" updated`, 'success');
        announce(`Rule updated`);
      } else {
        await api('/rules', { method: 'POST', body: built.draft });
        toast(`Rule "${built.draft.name || built.draft.pattern || 'New rule'}" created`, 'success');
        announce('Rule created');
      }
      dlg.close();
      refresh();
    } catch (err) {
      placeError(err);
      saveBtn.disabled = false;
    }
  });

  const content = el('div.rl-form', {},
    el('div.form-row', {},
      el('div', {}, el('label', { for: 'rl-name' }, 'Name (optional)'), nameInput),
    ),
    el('fieldset.rl-fs', {},
      el('legend', {}, 'Match type'),
      radioRow,
    ),
    patternRow,
    amountRow,
    el('div.form-row', {},
      el('div', {}, el('label', { for: 'rl-category' }, 'Target category'), catSel, catErr),
      el('div', {}, el('label', { for: 'rl-account' }, 'Account scope'), accountSel, acctErr),
    ),
    genErr,
    tester,
    el('div.dialog-actions', {},
      el('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      saveBtn,
    ),
  );

  syncMatchUi();
  const dlg = openDialog({
    title: rule ? `Edit rule \u2014 ${rule.name}` : 'New rule',
    onClose: () => {},
    content,
  });
  nameInput.focus();
}
