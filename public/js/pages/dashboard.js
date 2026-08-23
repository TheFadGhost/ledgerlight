import { api, fmtMoney, fmtDate, el, announce, getSettings } from '../lib.js';

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const MINUS = '\u2212';

let activeResizeHandler = null;

export async function render(view) {
  ensureStyles();
  detachResize();

  view.innerHTML = '';
  view.append(skeleton());

  let accounts;
  let meta;
  try {
    [accounts, meta] = await Promise.all([api('/accounts'), api('/meta')]);
  } catch (err) {
    view.innerHTML = '';
    view.append(errorPanel(err));
    return;
  }

  if (!accounts.length) {
    view.innerHTML = '';
    view.append(noAccountsView());
    return;
  }
  if (!meta.counts.transactions) {
    view.innerHTML = '';
    view.append(noTransactionsView());
    return;
  }

  const state = {
    month: null,
    bounds: await monthBounds(),
    charts: [],
    fromControl: false,
  };
  state.month = clampMonth(todayMonth(), state.bounds);

  attachResize(() => redrawCharts(state));
  await drawDashboard(view, state);
}

function detachResize() {
  if (activeResizeHandler) {
    window.removeEventListener('resize', activeResizeHandler);
    activeResizeHandler = null;
  }
}

function attachResize(fn) {
  detachResize();
  activeResizeHandler = () => {
    clearTimeout(fn.timer);
    fn.timer = setTimeout(fn, 150);
  };
  window.addEventListener('resize', activeResizeHandler);
}

function redrawCharts(state) {
  for (const draw of state.charts) {
    if (draw.el.isConnected) draw();
  }
}

function ensureStyles() {
  if (document.querySelector('link[data-pages-css="dashboard"]')) return;
  document.head.append(el('link', {
    rel: 'stylesheet',
    href: '/css/pages.css',
    'data-pages-css': 'dashboard',
  }));
}

function skeleton() {
  const wrap = el('div.skeleton-wrap');
  for (let i = 0; i < 5; i += 1) wrap.append(el('div.skeleton-bar'));
  return wrap;
}

function errorPanel(err) {
  return el('div.error-panel', {}, `Could not load the dashboard: ${err.message}`);
}

function noAccountsView() {
  return el('div.empty-state', {},
    el('h2', {}, 'Welcome to Ledgerlight'),
    el('p', {}, 'Ledgerlight does your money math on this machine only: import bank CSV exports, ' +
      'auto-categorize spending, and see exactly where each month goes.'),
    el('a.btn.btn-primary', { href: '/import', 'data-nav': 'import' }, 'Import CSV'),
  );
}

function noTransactionsView() {
  return el('div.empty-state', {},
    el('h2', {}, 'No transactions yet'),
    el('p', {}, 'Import a CSV export from your bank and the dashboard will fill in automatically.'),
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

async function drawDashboard(view, state) {
  const seq = (state.seq = (state.seq ?? 0) + 1);
  let dash;
  let recurring;
  try {
    [dash, recurring] = await Promise.all([
      api(`/dashboard?month=${state.month}`),
      api('/recurring').catch(() => []),
    ]);
  } catch (err) {
    view.innerHTML = '';
    view.append(errorPanel(err));
    return;
  }
  if (seq !== state.seq) return;

  state.charts = [];
  const root = el('div.dash-page');
  root.append(pageHead());
  if (dash.uncategorized.count > 0) root.append(uncategorizedBanner(dash));
  root.append(monthCard(dash, state));
  root.append(categoryCard(dash));
  root.append(timeCard(dash, state));
  root.append(ioeCard(dash, state));

  if (dash.budgets.length > 0) {
    root.append(el('div.dash-grid2', {}, merchantCard(dash), budgetCard(dash)));
  } else {
    root.append(merchantCard(dash));
  }
  root.append(recurringCard(recurring));

  view.innerHTML = '';
  view.append(root);
  for (const draw of state.charts) draw();
  announce(`Dashboard showing ${monthLabel(dash.month)}`);

  if (state.fromControl) {
    state.fromControl = false;
    const input = root.querySelector('input[type="month"]');
    if (input) input.focus({ preventScroll: true });
  }
}

function pageHead() {
  return el('div.page-head', {},
    el('h1', {}, 'Dashboard'),
    el('span.page-sub', {}, 'Where your money went, one month at a time'),
  );
}

function uncategorizedBanner(dash) {
  const u = dash.uncategorized;
  return el('div.dash-banner', { role: 'status' },
    el('span', {},
      el('strong', {}, `${u.count} ${u.count === 1 ? 'transaction' : 'transactions'} uncategorized`),
      ` totaling ${fmtMoney(u.totalMinor)} \u2014 these are excluded from category charts until categorized.`),
    el('a.btn.btn-sm', { href: '/transactions?uncategorized=1', 'data-nav': 'transactions' }, 'Review now'),
  );
}

function monthCard(dash, state) {
  const { bounds } = state;
  const prevDisabled = dash.month <= bounds.min;
  const nextDisabled = dash.month >= bounds.max;

  const input = el('input', {
    type: 'month',
    value: dash.month,
    min: bounds.min,
    max: bounds.max,
    'aria-label': 'Month',
  });
  input.addEventListener('change', () => {
    const v = /^\d{4}-\d{2}$/.test(input.value) ? input.value : dash.month;
    input.value = v;
    setMonth(state, v);
  });

  const prevBtn = el('button.btn.btn-sm', {
    type: 'button',
    'aria-label': 'Previous month',
    disabled: prevDisabled,
    onclick: () => setMonth(state, shiftMonth(dash.month, -1)),
  }, '\u2039');
  const nextBtn = el('button.btn.btn-sm', {
    type: 'button',
    'aria-label': 'Next month',
    disabled: nextDisabled,
    onclick: () => setMonth(state, shiftMonth(dash.month, 1)),
  }, '\u203A');

  const t = dash.mom.totals;
  const stats = el('div.dash-stats', {},
    stat('Income', fmtMoney(t.incomeMinor)),
    stat('Expenses', fmtMoney(t.expenseMinor), 'amount-neg'),
    stat('Net', fmtMoney(t.netMinor), t.netMinor > 0 ? 'amount-pos' : t.netMinor < 0 ? 'amount-neg' : ''),
  );

  const card = el('div.card.dash-month-card', {},
    el('div.flex-between', {},
      el('h2', {}, monthLabel(dash.month)),
      el('div.dash-controls', {}, prevBtn, input, nextBtn),
    ),
    el('div.muted.dash-prev-note', {}, `Compared with ${monthLabel(dash.previousMonth)}`),
    stats,
    deltaRow(dash),
  );

  if (dash.month === todayMonth()) {
    const days = Number(todayISO().slice(8, 10));
    card.append(el('p.muted.dash-partial', {},
      `Month in progress \u2014 ${days} ${days === 1 ? 'day' : 'days'}`));
  }
  return card;
}

function stat(label, value, cls) {
  return el('div.dash-stat', {},
    el('div.dash-stat-label', {}, label),
    el('div.dash-stat-value.num' + (cls ? `.${cls}` : ''), {}, value),
  );
}

function deltaRow(dash) {
  const t = dash.mom.totals;
  const metrics = [
    { label: 'Income', cur: t.incomeMinor, prev: t.prevIncomeMinor, spend: false },
    { label: 'Expenses', cur: -t.expenseMinor, prev: -t.prevExpenseMinor, spend: true },
    { label: 'Net', cur: t.netMinor, prev: t.prevNetMinor, spend: false },
  ];
  const chips = [];
  for (const m of metrics) {
    if (m.cur === 0 && m.prev === 0) continue;
    const diff = m.cur - m.prev;
    const arrow = diff > 0 ? '\u25B2 ' : diff < 0 ? '\u25BC ' : '';
    const word = diff > 0 ? 'more' : diff < 0 ? 'less' : 'unchanged';
    const cls = diff > 0 ? (m.spend ? 'delta-up' : '') : diff < 0 ? (m.spend ? 'delta-down' : '') : 'dash-delta-flat';
    chips.push(el('span.dash-delta' + (cls ? `.${cls}` : ''), {},
      `${m.label} ${arrow}${signedMoney(diff)} ${word}`));
  }
  if (!chips.length) return el('span');
  return el('div.dash-deltas', {}, ...chips);
}

function signedMoney(diff) {
  if (diff > 0) return `+${fmtMoney(diff)}`;
  if (diff < 0) return `${MINUS}${fmtMoney(-diff)}`;
  return fmtMoney(0);
}

function setMonth(state, month) {
  if (month === state.month) return;
  state.month = clampMonth(month, state.bounds);
  state.fromControl = true;
  const view = document.getElementById('view');
  drawDashboard(view, state);
}

function categoryCard(dash) {
  const card = el('div.card', {});
  card.append(el('div.flex-between', {},
    el('h2', {}, 'Spend by category'),
    el('span.muted', {}, 'Top 12'),
  ));

  const rows = dash.byCategory.filter((r) => r.totalMinor !== 0);
  if (!rows.length) {
    card.append(el('p.dash-empty', {}, 'No spending recorded this month.'));
    return card;
  }

  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.totalMinor)));
  const momMap = new Map(dash.mom.categories.map((c) => [c.categoryId, c]));
  const prevLabel = monthLabel(dash.previousMonth);

  const list = el('ul.dash-bars');
  rows.forEach((r, i) => {
    const uncategorized = r.categoryId == null;
    const colour = uncategorized ? cssVar('--ink-faint') : cssVar(`--chart-${(i % 6) + 1}`);
    const pct = Math.max(1, Math.round((Math.abs(r.totalMinor) / maxAbs) * 100));
    const mom = r.categoryId != null ? momMap.get(r.categoryId) : undefined;

    list.append(el('li.dash-bar-row', {},
      el('span.dash-bar-label', { title: r.parentName ? `${r.parentName} \u203A ${r.name}` : r.name }, r.name),
      el('span.dash-bar-track', {},
        el('span.dash-bar-fill', { style: `width:${pct}%;background:${colour}` })),
      el('span.num', {}, fmtMoney(r.totalMinor)),
      deltaChip(mom, prevLabel),
    ));
  });
  card.append(list);
  return card;
}

function deltaChip(mom, prevLabel) {
  if (!mom || mom.deltaBps == null) {
    return el('span.muted.dash-mom', { 'aria-label': 'No comparison' }, '\u2014');
  }
  const pct = Math.round(mom.deltaBps / 100);
  const arrow = pct > 0 ? '\u25B2 ' : pct < 0 ? '\u25BC ' : '\u00B10% ';
  const sign = pct > 0 ? '+' : pct < 0 ? MINUS : '';
  const cls = pct > 0 ? 'dash-chip-up' : pct < 0 ? 'dash-chip-down' : 'dash-chip-flat';
  return el('span.dash-mom.chip', {
    class: `dash-mom chip ${cls}`,
    title: `${fmtMoney(mom.previousMinor)} in ${prevLabel}`,
  }, `${arrow}${sign}${Math.abs(pct)}%`);
}

function timeCard(dash, state) {
  const card = el('div.card', {}, el('h2', {}, 'Spend over time'));
  const series = dailySeries(dash.overTime, dash.month);
  const max = Math.max(...series.map((d) => d.mag));
  if (max <= 0) {
    card.append(el('p.dash-empty', {}, 'No spending recorded this month.'));
    return card;
  }

  const peak = series.reduce((a, b) => (b.mag > a.mag ? b : a));
  const label = `Daily spending ${monthLabel(dash.month)}, peak ${fmtMoney(peak.mag)} on ${fmtDate(peak.day)}`;

  const wrap = el('div.dash-chart-wrap', {});
  card.append(wrap);
  const draw = () => drawLineChart(wrap, series, label);
  state.charts.push(draw);
  draw();
  return card;
}

function drawLineChart(wrap, series, ariaLabel) {
  const w = Math.max(320, wrap.clientWidth || 720);
  const h = 220;
  const padL = 52;
  const padR = 10;
  const padT = 12;
  const padB = 24;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const n = series.length;
  const yMax = niceCeil(Math.max(...series.map((d) => d.mag)));

  const svg = elNS('svg', {
    width: w,
    height: h,
    role: 'img',
    'aria-label': ariaLabel,
    tabindex: '0',
  });
  const yOf = (v) => padT + innerH - (v / yMax) * innerH;
  const xOf = (i) => padL + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));

  for (let k = 1; k <= 4; k += 1) {
    const y = yOf((yMax * k) / 4);
    svg.append(elNS('line', {
      x1: padL, x2: w - padR, y1: y, y2: y,
      stroke: 'var(--border)', 'stroke-dasharray': '3 3', 'stroke-width': '1',
    }));
  }
  svg.append(elNS('line', {
    x1: padL, x2: w - padR, y1: yOf(0), y2: yOf(0),
    stroke: 'var(--border)', 'stroke-width': '1',
  }));
  for (let k = 0; k <= 4; k += 1) {
    const v = (yMax * k) / 4;
    svg.append(elNS('text', {
      x: padL - 8, y: yOf(v) + 3.5, 'text-anchor': 'end', class: 'dash-axis-text',
    }, abbrevMoney(v)));
  }

  const labelStep = Math.max(1, Math.ceil((n * 40) / innerW));
  let lastLabeled = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const isLast = i === n - 1;
    const due = i % labelStep === 0 || (isLast && i - lastLabeled >= labelStep / 2);
    if (!due) continue;
    lastLabeled = i;
    const day = Number(series[i].day.slice(8, 10));
    const mon = MONTHS_SHORT[Number(series[i].day.slice(5, 7)) - 1];
    svg.append(elNS('text', {
      x: Math.min(Math.max(xOf(i), padL + 12), w - padR - 12),
      y: h - 6, 'text-anchor': 'middle', class: 'dash-axis-text',
    }, `${day} ${mon}`));
  }

  const points = series.map((d, i) => [xOf(i), yOf(d.mag)]);
  svg.append(elNS('path', {
    d: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(''),
    fill: 'none', stroke: 'var(--chart-1)', 'stroke-width': '2',
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  const dot = elNS('circle', {
    r: '3.5', fill: 'var(--chart-1)', stroke: 'var(--surface)', 'stroke-width': '1.5', visibility: 'hidden',
  });
  svg.append(dot);

  const tip = makeTip(wrap);
  const colW = innerW / Math.max(1, n - 1);
  series.forEach((d, i) => {
    const hit = elNS('rect', {
      x: xOf(i) - colW / 2, y: padT, width: Math.max(colW, 4), height: innerH,
      fill: 'transparent', tabindex: '0',
      'aria-label': `${fmtDate(d.day)}: ${fmtMoney(d.mag)}`,
    });
    const show = () => {
      dot.setAttribute('cx', xOf(i));
      dot.setAttribute('cy', yOf(d.mag));
      dot.setAttribute('visibility', 'visible');
      tip.show(fmtDate(d.day), [['Spent', fmtMoney(d.mag)]], xOf(i), yOf(d.mag), wrap);
    };
    const hide = () => {
      dot.setAttribute('visibility', 'hidden');
      tip.hide();
    };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('mouseleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
    svg.append(hit);
  });

  wrap.replaceChildren(svg, tip.node);
}

function ioeCard(dash, state) {
  const card = el('div.card', {}, el('h2', {}, 'Income vs expenses'));
  const months = dash.summary.slice(-6);
  const hasActivity = months.some((m) => m.incomeMinor !== 0 || m.expenseMinor !== 0);
  if (!months.length || !hasActivity) {
    card.append(el('p.dash-empty', {}, 'No income or expenses recorded in this period yet.'));
    return card;
  }

  card.append(el('div.dash-legend', {},
    legendItem('var(--positive)', 'Income'),
    legendItem('var(--negative)', 'Expenses'),
  ));

  const wrap = el('div.dash-chart-wrap', {});
  card.append(wrap);
  const range = `${monthLabel(months[0].month)} to ${monthLabel(months[months.length - 1].month)}`;
  const draw = () => drawGroupedBars(wrap, months, `Income versus expenses, ${range}`);
  state.charts.push(draw);
  draw();
  return card;
}

function legendItem(colour, word) {
  return el('span', {}, el('span.dash-swatch', { style: `background:${colour}` }), word);
}

function drawGroupedBars(wrap, months, ariaLabel) {
  const w = Math.max(320, wrap.clientWidth || 720);
  const h = 220;
  const padL = 52;
  const padR = 10;
  const padT = 12;
  const padB = 24;
  const innerW = w - padL - padR;
  const halfH = (h - padT - padB) / 2;
  const y0 = padT + halfH;
  const scale = niceCeil(Math.max(...months.flatMap((m) => [Math.abs(m.incomeMinor), Math.abs(m.expenseMinor)])));

  const svg = elNS('svg', {
    width: w, height: h, role: 'img', 'aria-label': ariaLabel, tabindex: '0',
  });

  for (const frac of [1, 0.5]) {
    for (const dir of [1, -1]) {
      const y = y0 - dir * frac * halfH;
      svg.append(elNS('line', {
        x1: padL, x2: w - padR, y1: y, y2: y,
        stroke: 'var(--border)', 'stroke-dasharray': '3 3', 'stroke-width': '1',
      }));
      svg.append(elNS('text', {
        x: padL - 8, y: y + 3.5, 'text-anchor': 'end', class: 'dash-axis-text',
      }, abbrevMoney(dir * frac * scale)));
    }
  }
  svg.append(elNS('line', {
    x1: padL, x2: w - padR, y1: y0, y2: y0, stroke: 'var(--border)', 'stroke-width': '1',
  }));

  const gw = innerW / months.length;
  const barW = Math.min(34, gw * 0.32);
  const tip = makeTip(wrap);

  months.forEach((m, i) => {
    const cx = padL + gw * i + gw / 2;
    const incH = (Math.max(m.incomeMinor, 0) / scale) * halfH;
    const expH = (Math.abs(Math.min(m.expenseMinor, 0)) / scale) * halfH;

    if (incH > 0) {
      svg.append(elNS('rect', {
        x: cx - barW - 1, y: y0 - incH, width: barW, height: incH,
        fill: 'var(--positive)',
      }));
    }
    if (expH > 0) {
      svg.append(elNS('rect', {
        x: cx + 1, y: y0, width: barW, height: expH,
        fill: 'var(--negative)',
      }));
    }
    svg.append(elNS('text', {
      x: cx, y: h - 6, 'text-anchor': 'middle', class: 'dash-axis-text',
    }, MONTHS_SHORT[Number(m.month.slice(5, 7)) - 1]));

    const hit = elNS('rect', {
      x: padL + gw * i, y: padT, width: gw, height: h - padT - padB,
      fill: 'transparent', tabindex: '0',
      'aria-label': `${monthLabel(m.month)}: income ${fmtMoney(m.incomeMinor)}, expenses ${fmtMoney(m.expenseMinor)}`,
    });
    const show = () => tip.show(monthLabel(m.month), [
      ['Income', fmtMoney(m.incomeMinor)],
      ['Expenses', fmtMoney(m.expenseMinor)],
    ], cx, Math.min(y0 - incH, y0 + 4), wrap);
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('mouseleave', () => tip.hide());
    hit.addEventListener('blur', () => tip.hide());
    svg.append(hit);
  });

  wrap.replaceChildren(svg, tip.node);
}

function merchantCard(dash) {
  const card = el('div.card', {}, el('h2', {}, 'Top merchants'));
  if (!dash.topMerchants.length) {
    card.append(el('p.dash-empty', {}, 'No spending recorded this month.'));
    return card;
  }
  const list = el('ul.dash-list');
  for (const m of dash.topMerchants) {
    list.append(el('li.dash-list-row', {},
      el('span.dash-grow', { title: m.payee }, m.payee),
      el('span.muted', {}, `${m.txnCount} ${m.txnCount === 1 ? 'txn' : 'txns'}`),
      el('span.num', {}, fmtMoney(m.totalMinor)),
    ));
  }
  card.append(list);
  return card;
}

function budgetCard(dash) {
  const card = el('div.card', {});
  card.append(el('div.flex-between', {},
    el('h2', {}, 'Budgets snapshot'),
    el('a', { href: '/budgets', 'data-nav': 'budgets' }, 'Manage budgets'),
  ));
  const list = el('ul.dash-list');
  for (const b of dash.budgets.slice(0, 5)) {
    const pct = Math.min(100, Math.max(1, Math.round(b.pctUsedBps / 100)));
    const chip = budgetChip(b);
    list.append(el('li.dash-budget', {},
      el('div.dash-list-row', {},
        el('span.dash-grow', {}, b.categoryName),
        el('span.num', {}, fmtMoney(b.spentMinor)),
        el('span.muted', {}, ` of ${fmtMoney(b.monthlyAmountMinor)}`),
      ),
      el('div.dash-progress-row', {},
        el('div.progress-track', {},
          el('div.progress-fill' + (b.state === 'over' ? '.over' : b.state === 'near' ? '.near' : ''),
            { style: `width:${pct}%` })),
        el('span.muted.num', {}, `${Math.round(b.pctUsedBps / 100)}%`),
        chip,
      ),
    ));
  }
  card.append(list);
  return card;
}

function budgetChip(b) {
  if (b.state === 'over') {
    return el('span.chip.chip-neg', {}, `\u25B2 Over by ${fmtMoney(Math.abs(b.remainingMinor))}`);
  }
  if (b.state === 'near') {
    return el('span.chip.chip-warn', {}, '! Near limit');
  }
  return el('span.chip', {}, '\u2713 Under budget');
}

function recurringCard(items) {
  const card = el('div.card', {}, el('h2', {}, 'Recurring payments'));
  if (!items.length) {
    card.append(el('p.dash-empty', {},
      'No repeating payments detected yet. The detector appears here once a payee shows ' +
      'three or more similar payments on a steady cadence.'));
    return card;
  }
  const list = el('ul.dash-list');
  const missedCutoff = addDaysISO(todayISO(), -7);
  for (const r of items) {
    const steady = r.stabilityPct >= 85;
    const overdue = r.nextExpectedDate < missedCutoff;
    list.append(el('li.dash-list-row.dash-rec', {},
      el('span.dash-grow', {},
        el('span.dash-rec-payee', {}, r.payeeDisplay),
        el('span.dash-rec-chips', {},
          el('span.chip', {}, cap(r.cadence)),
          el('span.chip', {}, cap(r.confidence)),
          overdue ? el('span.chip.chip-warn', { title: 'Expected before today minus seven days' }, 'Missed?') : null,
        ),
        el('div.dash-rec-sub', {},
          `${r.occurrences} payments \u00B7 ${steady ? 'steady' : 'varies'} \u00B7 next expected ${fmtDate(r.nextExpectedDate)}`),
      ),
      el('span.dash-rec-amt', {},
        el('span.num', {}, fmtMoney(r.medianAmountMinor)),
        el('div.muted', {}, `per ${cadenceUnit(r.cadence)}`),
      ),
    ));
  }
  card.append(list);
  return card;
}

function makeTip(wrapRef) {
  const node = el('div.dash-tip', { hidden: true });
  return {
    node,
    show(title, rows, x, y, wrap) {
      node.replaceChildren(
        el('div.dash-tip-title', {}, title),
        ...rows.map(([lab, val]) => el('div.dash-tip-row', {}, el('span', {}, lab), el('span.num', {}, val))),
      );
      node.hidden = false;
      const host = wrap || wrapRef;
      const tw = node.offsetWidth;
      const th = node.offsetHeight;
      const W = host.clientWidth;
      let left = x - tw / 2;
      left = Math.max(4, Math.min(left, W - tw - 4));
      let top = y - th - 10;
      if (top < 2) top = y + 14;
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
    },
    hide() {
      node.hidden = true;
    },
  };
}

export function abbrevMoney(minor) {
  const symbol = getSettings()?.display?.symbol ?? '$';
  const neg = minor < 0 ? MINUS : '';
  const d = Math.abs(minor) / 100;
  const trim = (v) => {
    const s = v.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  let body;
  if (d >= 1e6 - 50) body = `${trim(d / 1e6)}m`;
  else if (d >= 1e3) body = `${trim(d / 1e3)}k`;
  else body = String(Math.round(d));
  return `${neg}${symbol}${body}`;
}

function niceCeil(max) {
  if (!(max > 0)) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  const f = max / base;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * base;
}

function dailySeries(overTime, month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const map = new Map(overTime.map((r) => [r.day, -r.totalMinor]));
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    out.push({ day: key, mag: map.get(key) ?? 0 });
  }
  return out;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function elNS(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, v);
  }
  return node;
}

function monthLabel(key) {
  return `${MONTHS_FULL[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

function cap(word) {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

function cadenceUnit(cadence) {
  return { weekly: 'week', fortnightly: 'two weeks', monthly: 'month', annual: 'year' }[cadence] ?? cadence;
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

function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
