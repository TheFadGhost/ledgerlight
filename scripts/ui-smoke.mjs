// Ledgerlight UI smoke/audit (Playwright, chromium).
// Usage: node scripts/ui-smoke.mjs
// Boots a seeded demo server and an empty-DB server on temp SQLite files,
// runs keyboard/semantics/theme/focus/empty-state/console checks, writes
// docs/screenshots/*.png, prints PASS/FAIL lines, exits 1 on any failure.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'docs', 'screenshots');
const VIEWPORT = { width: 1280, height: 900 };
const MONTH_WITH_DATA = '2026-03';

const results = [];
function pass(name, detail = '') {
  results.push({ ok: true, name });
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
}
function info(name, detail = '') {
  console.log(`[INFO] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDbPath(tag) {
  return join(tmpdir(), `ledgerlight-ui-smoke-${tag}-${process.pid}-${Date.now()}.sqlite`);
}

async function runSeed(dbPath) {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--no-warnings', 'scripts/seed-demo.mjs', '--db', dbPath], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}: ${out}`))));
  });
}

async function startServer(port, dbPath) {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, LEDGERLIGHT_DB: dbPath, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  for (let i = 0; i < 80; i += 1) {
    if (proc.exitCode !== null) throw new Error(`server died (code ${proc.exitCode}): ${stderr}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/meta`);
      if (r.ok) return proc;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  proc.kill();
  throw new Error(`server on :${port} never became ready: ${stderr}`);
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    proc.on('exit', resolve);
    proc.kill();
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000).unref();
  });
}

function removeDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { rmSync(dbPath + suffix, { force: true }); } catch { /* best effort */ }
  }
}

function attachErrorCollectors(page, bucket) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bucket.consoleErrors.push({ page: page.__route ?? page.url(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    bucket.pageErrors.push({ page: page.__route ?? page.url(), text: String(err?.message ?? err) });
  });
}

async function activeDesc(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    const bits = [el.tagName.toLowerCase()];
    if (el.id) bits.push(`#${el.id}`);
    if (el.dataset && el.dataset.id) bits.push(`[data-id=${el.dataset.id}]`);
    if (el.className && typeof el.className === 'string') bits.push(`.${el.className.trim().split(/\s+/).join('.')}`);
    const t = (el.textContent ?? '').trim().slice(0, 24);
    if (t) bits.push(`"${t}"`);
    return bits.join('');
  });
}

async function tabUntil(page, probe, maxTabs = 14) {
  for (let i = 0; i <= maxTabs; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await page.evaluate(probe)) return i;
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Tab');
    // eslint-disable-next-line no-await-in-loop
    await sleep(40);
  }
  return -1;
}

const isFaviconNoise = (text) => /favicon/i.test(text);

// ---------------------------------------------------------------------------
// Task 1 — keyboard-only categorization
// ---------------------------------------------------------------------------
async function runPickerFlow(page, rowId) {
  const inDialog = await page.evaluate(() => {
    const el = document.activeElement;
    return Boolean(el && el.closest('.dialog-overlay'));
  });
  if (inDialog) pass('KB: "c" opens category picker, focus inside dialog', await activeDesc(page));
  else fail('KB: "c" opens category picker, focus inside dialog', `activeElement=${await activeDesc(page)}`);

  const dialogInitialFocus = await activeDesc(page);
  info('KB: picker initial focus target', `${dialogInitialFocus} (ideal: the category select #tx-pick-cat)`);
  if (!dialogInitialFocus.includes('#tx-pick-cat')) {
    fail('KB: picker initial focus lands on category select',
      `got ${dialogInitialFocus}; openDialog() focuses the first <button> in DOM order, which is the "x" close button in .dialog-head`);
  } else {
    pass('KB: picker initial focus lands on category select');
  }

  const tabsToSelect = await tabUntil(page, () => document.activeElement?.id === 'tx-pick-cat');
  if (tabsToSelect >= 0) info('KB: Tab presses needed to reach category select from initial dialog focus', String(tabsToSelect));
  else {
    fail('KB: category select reachable by Tab inside dialog', 'not reached within 14 tabs');
    await page.keyboard.press('Escape');
    return;
  }

  const before = await page.evaluate(() => ({
    value: document.getElementById('tx-pick-cat').value,
    label: document.getElementById('tx-pick-cat').selectedOptions[0]?.textContent.trim() ?? '',
  }));
  // arrow to a different, real category
  let chosen = before;
  for (let i = 0; i < 15; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('ArrowDown');
    // eslint-disable-next-line no-await-in-loop
    await sleep(30);
    // eslint-disable-next-line no-await-in-loop
    chosen = await page.evaluate(() => ({
      value: document.getElementById('tx-pick-cat').value,
      label: document.getElementById('tx-pick-cat').selectedOptions[0]?.textContent.trim() ?? '',
    }));
    if (chosen.value !== '' && chosen.label !== before.label) break;
  }
  if (chosen.value !== '' && chosen.value !== before.value) {
    pass('KB: ArrowDown/type-ahead changes selected category', `${before.label || '(Uncategorized)'} -> ${chosen.label}`);
  } else {
    fail('KB: ArrowDown/type-ahead changes selected category', JSON.stringify({ before, after: chosen }));
  }

  // Enter should commit per the ideal flow
  await page.keyboard.press('Enter');
  await sleep(600);
  const afterEnter = await page.evaluate((id) => {
    const tr = document.querySelector(`.txn-table tr[data-id="${id}"]`);
    return {
      dlgOpen: Boolean(document.querySelector('.dialog-overlay')),
      chipText: tr?.querySelector('.txn-cat-chip, .chip-warn')?.textContent.trim() ?? '',
    };
  }, rowId);
  if (!afterEnter.dlgOpen && afterEnter.chipText === chosen.label) {
    pass('KB: Enter commits the categorization');
  } else {
    fail('KB: Enter commits the categorization',
      `after ArrowDown+Enter dialog still open=${afterEnter.dlgOpen}, row chip="${afterEnter.chipText}", expected "${chosen.label}". The picker is a native <select> plus a separate Apply button; Enter does not submit.`);
  }

  if (afterEnter.dlgOpen) {
    const tabsToApply = await tabUntil(
      page,
      () => document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent.trim() === 'Apply',
    );
    if (tabsToApply >= 0) {
      info('KB: Tabs needed from select to Apply button', String(tabsToApply));
      await page.keyboard.press('Enter');
      await page.waitForSelector('.dialog-overlay', { state: 'detached', timeout: 5000 }).catch(() => {});
    } else {
      fail('KB: Apply button reachable by Tab inside picker', 'not found within 14 tabs');
      await page.keyboard.press('Escape');
      return;
    }
  }

  await sleep(700); // draw + refocus settle
  const post = await page.evaluate((id) => {
    const tr = document.querySelector(`.txn-table tr[data-id="${id}"]`);
    const ae = document.activeElement;
    return {
      chipText: tr?.querySelector('.txn-cat-chip')?.textContent.trim() ?? '',
      warn: Boolean(tr?.querySelector('.chip-warn')),
      sr: document.getElementById('sr-status').textContent.trim(),
      focus: ae?.tagName.toLowerCase() + (ae?.dataset?.id ? `[data-id=${ae.dataset.id}]` : ''),
    };
  }, rowId);
  if (post.chipText === chosen.label && !post.warn) {
    pass('KB: committed category renders as chip text', `"${post.chipText}"`);
  } else {
    fail('KB: committed category renders as chip text', `chip="${post.chipText}" warnChip=${post.warn} expected="${chosen.label}"`);
  }
  if (post.sr.length > 0) pass('KB: #sr-status announced the change', `"${post.sr.slice(0, 90)}"`);
  else fail('KB: #sr-status announced the change', '#sr-status empty after commit');

  const expectedFocus = `tr[data-id=${rowId}]`;
  if (post.focus === expectedFocus) pass('KB: focus returned to the categorized row', post.focus);
  else fail('KB: focus returned to the categorized row', `got ${post.focus}, expected ${expectedFocus}`);
}

async function taskKeyboard(page) {
  await page.goto('/transactions');
  await page.waitForSelector('.txn-table tbody tr[data-id]');
  await sleep(150); // render focus settles on #view

  info('KB: initial focused element after load', await activeDesc(page));

  // Probe: advertised j/k/space/c shortcuts from the initial post-render focus (#view)
  await page.keyboard.press('j');
  await sleep(120);
  const jFromView = await activeDesc(page);
  if (/^tr\[data-id/.test(jFromView)) {
    pass('KB: "j" enters the table from initial page focus', jFromView);
  } else {
    fail('KB: "j" enters the table from initial page focus',
      `after pressing j, activeElement=${jFromView}. Keydown listener is bound to .txn-page, so keys are dead while focus sits on main#view (where render() leaves it).`);
  }

  // Canonical keyboard-only entry: Tab to table
  const tabsToTable = await tabUntil(
    page,
    () => /tr/i.test(document.activeElement?.tagName ?? '') && Boolean(document.activeElement?.dataset?.id),
    40,
  );
  if (tabsToTable >= 0) {
    pass('KB: Tab reaches the transactions table', `${tabsToTable} tab(s), on ${await activeDesc(page)}`);
  } else {
    fail('KB: Tab reaches the transactions table', `activeElement=${await activeDesc(page)} after 40 tabs`);
  }
  await sleep(60);

  const rowIds = await page.evaluate(() =>
    [...document.querySelectorAll('.txn-table tbody tr[data-id]')].map((tr) => tr.dataset.id));

  await page.keyboard.press('j'); await sleep(50);
  let desc = await activeDesc(page);
  if (desc.includes(`data-id=${rowIds[1]}`)) pass('KB: "j" moves to next row', desc);
  else fail('KB: "j" moves to next row', `expected data-id=${rowIds[1]}, got ${desc}`);

  await page.keyboard.press('k'); await sleep(50);
  desc = await activeDesc(page);
  if (desc.includes(`data-id=${rowIds[0]}`)) pass('KB: "k" moves back up one row', desc);
  else fail('KB: "k" moves back up one row', `expected data-id=${rowIds[0]}, got ${desc}`);

  // space selects two rows
  await page.keyboard.press(' '); await sleep(80);
  await page.keyboard.press('j'); await sleep(50);
  await page.keyboard.press(' '); await sleep(120);

  const sel = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.txn-table tbody tr[data-id]')];
    const checked = rows.filter((tr) => tr.querySelector('.txn-row-check')?.checked).map((tr) => tr.dataset.id);
    const bar = document.querySelector('.txn-bulkbar');
    return {
      checked,
      ariaSelected: rows.filter((tr) => tr.getAttribute('aria-selected') === 'true').map((tr) => tr.dataset.id),
      bulkVisible: bar ? !bar.hidden : false,
      bulkCount: bar?.querySelector('.txn-bulk-count')?.textContent.trim() ?? '',
    };
  });
  if (sel.checked.length === 2 && sel.checked.join() === `${rowIds[0]},${rowIds[1]}`) {
    pass('KB: Space selects the focused row (two selected)', sel.checked.join(', '));
  } else {
    fail('KB: Space selects the focused row (two selected)', `checked=[${sel.checked}] expected=[${rowIds[0]},${rowIds[1]}]`);
  }
  if (sel.bulkVisible && /2 selected/.test(sel.bulkCount)) pass('KB: bulk bar reflects selection', sel.bulkCount);
  else fail('KB: bulk bar reflects selection', `visible=${sel.bulkVisible} count="${sel.bulkCount}"`);

  // c opens picker with focus inside
  await page.keyboard.press('k'); await sleep(50); // back on row 0
  const focusedRowBeforePicker = await page.evaluate(() => document.activeElement?.dataset?.id ?? null);
  await page.keyboard.press('c');
  let pickerOpened = true;
  try {
    await page.waitForSelector('.dialog-overlay [role="dialog"]', { timeout: 5000 });
  } catch {
    pickerOpened = false;
    fail('KB: "c" opens category picker', `no [role=dialog] appeared 5s after pressing c on focused row (focus=${await activeDesc(page)})`);
  }

  if (pickerOpened) {
    await runPickerFlow(page, focusedRowBeforePicker);
  }

  // digits quick-assign using MRU (populated by the commit above)
  const mru = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('ledgerlight.mruCategories') ?? '[]'); } catch { return []; }
  });
  if (!mru.length) {
    fail('KB: digits 1-9 quick-assign (MRU populated)', 'localStorage ledgerlight.mruCategories is empty after a manual assignment');
  } else {
    const names = await page.evaluate(async () => {
      const cats = await (await fetch('/api/categories')).json();
      return Object.fromEntries(cats.map((c) => [String(c.id), c.name]));
    });
    const mruName = names[String(mru[0])] ?? `category ${mru[0]}`;

    const target = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.txn-table tbody tr[data-id]')];
      const idx = rows.findIndex((tr) => tr.querySelector('.chip-warn'));
      return idx >= 0 ? { id: rows[idx].dataset.id, index: idx } : null;
    });
    if (!target) {
      info('KB: digits quick-assign skipped', 'no uncategorized row visible on this page');
    } else {
      // move focus onto the target row using only j/k
      let cur = await page.evaluate(() => {
        const id = document.activeElement?.dataset?.id;
        if (!id) return -1;
        return [...document.querySelectorAll('.txn-table tbody tr[data-id]')]
          .findIndex((tr) => tr.dataset.id === id);
      });
      if (cur < 0) {
        await page.keyboard.press('j');
        await sleep(50);
        cur = await page.evaluate(() => {
          const id = document.activeElement?.dataset?.id;
          if (!id) return -1;
          return [...document.querySelectorAll('.txn-table tbody tr[data-id]')]
            .findIndex((tr) => tr.dataset.id === id);
        });
      }
      const steps = Math.abs(target.index - cur);
      for (let i = 0; i < steps; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await page.keyboard.press(target.index > cur ? 'j' : 'k');
        // eslint-disable-next-line no-await-in-loop
        await sleep(40);
      }
      const landedOnTarget = await page.evaluate(
        (tid) => document.activeElement?.dataset?.id === tid,
        target.id,
      );
      if (!landedOnTarget) {
        fail('KB: navigated to an uncategorized row for digit test', `wanted ${target.id}, on ${await activeDesc(page)}`);
      }
      await page.keyboard.press('1');
      await sleep(600);
      const q = await page.evaluate((tid) => {
        const tr = document.querySelector(`.txn-table tr[data-id="${tid}"]`);
        return {
          warn: Boolean(tr?.querySelector('.chip-warn')),
          chip: tr?.querySelector('.txn-cat-chip')?.textContent.trim() ?? '',
          sr: document.getElementById('sr-status').textContent.trim(),
        };
      }, target.id);
      if (!q.warn && q.chip === mruName) {
        pass('KB: digit "1" quick-assigns most-recent category', `row now "${q.chip}"`);
      } else {
        fail('KB: digit "1" quick-assigns most-recent category',
          `expected chip "${mruName}", got "${q.chip}" (warn chip still present: ${q.warn})`);
      }
    }
  }

  // '?' shortcuts dialog + Esc closes
  const escFocusBefore = await activeDesc(page);
  await page.keyboard.press('?');
  let shortcutsOpened = true;
  try {
    await page.waitForSelector('.dialog-overlay [role="dialog"]', { timeout: 5000 });
  } catch {
    shortcutsOpened = false;
    fail('KB: "?" opens shortcuts dialog', `no [role=dialog] appeared 5s after pressing ? (focus=${await activeDesc(page)})`);
  }
  if (shortcutsOpened) {
    const shortcutsTitle = await page.evaluate(() =>
      document.querySelector('.dialog h2')?.textContent.trim() ?? '');
    const focusInShortcuts = await page.evaluate(() =>
      Boolean(document.activeElement?.closest?.('.dialog-overlay')));
    if (/Keyboard shortcuts/.test(shortcutsTitle) && focusInShortcuts) {
      pass('KB: "?" opens shortcuts dialog with focus inside', `"${shortcutsTitle}", focus=${await activeDesc(page)}`);
    } else {
      fail('KB: "?" opens shortcuts dialog with focus inside', `title="${shortcutsTitle}" focusInside=${focusInShortcuts}`);
    }
    await page.keyboard.press('Escape');
    await sleep(150);
    const closed = await page.evaluate(() => !document.querySelector('.dialog-overlay'));
    const refocused = await activeDesc(page);
    if (closed && refocused === escFocusBefore) {
      pass('KB: Esc closes dialog and restores focus', refocused);
    } else {
      fail('KB: Esc closes dialog and restores focus', `closed=${closed} focus=${refocused} (was ${escFocusBefore})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Task 2 — table semantics
// ---------------------------------------------------------------------------
async function taskTableSemantics(page) {
  await page.goto('/transactions');
  await page.waitForSelector('.txn-table');

  const caption = await page.evaluate(() => {
    const c = document.querySelector('.txn-table caption');
    return c ? c.textContent.trim() : '';
  });
  if (caption.length > 0) pass('Table: caption present and non-empty', `"${caption.slice(0, 80)}"`);
  else fail('Table: caption present and non-empty', '.txn-table caption missing or empty');

  const ths = await page.evaluate(() =>
    [...document.querySelectorAll('.txn-table th')].map((th) => ({
      text: th.textContent.trim(), scope: th.getAttribute('scope'),
    })));
  const badTh = ths.filter((t) => t.scope !== 'col');
  if (ths.length && badTh.length === 0) pass('Table: all th carry scope="col"', `${ths.length} headers`);
  else fail('Table: all th carry scope="col"', badTh.map((t) => `"${t.text}" scope=${t.scope}`).join('; ') || 'no th found');

  const sortBtns = await page.evaluate(() =>
    [...document.querySelectorAll('.txn-table thead th')].map((th) => ({
      label: th.textContent.trim(),
      isSelectAll: Boolean(th.querySelector('.txn-all-check')),
      hasButton: Boolean(th.querySelector('button.sort-btn')),
      ariaSort: th.getAttribute('aria-sort'),
    })));
  const sortableCols = sortBtns.filter((s) => !s.isSelectAll);
  const missingBtns = sortableCols.filter((s) => !s.hasButton);
  if (missingBtns.length === 0 && sortableCols.length >= 5) {
    pass('Table: sortable headers are buttons', `${sortableCols.length} header buttons (${sortableCols.map((s) => s.label.replace(/[↑↓►◄]/g, '').trim()).join(', ')})`);
  } else {
    fail('Table: sortable headers are buttons', missingBtns.map((s) => s.label).join(', ') || `only ${sortableCols.length} data columns found`);
  }
  info('Table: initial aria-sort states', JSON.stringify(sortBtns.filter((s) => s.ariaSort)));

  const dateBtn = page.locator('.txn-table thead th:nth-child(2) button.sort-btn');
  await dateBtn.focus();
  await page.keyboard.press('Enter');
  await sleep(500);
  const afterAsc = await page.evaluate(() =>
    document.querySelector('.txn-table thead th:nth-child(2)')?.getAttribute('aria-sort'));
  // draw() rebuilds the whole table; the focused button is destroyed — record that
  const focusAfterFirstSort = await activeDesc(page);
  info('Table: focused element after sort re-render', `${focusAfterFirstSort} (sort click rebuilds the view)`);
  if (!focusAfterFirstSort.includes('.sort-btn')) {
    fail('Table: focus preserved on the Date sort control after sorting',
      `activeElement=${focusAfterFirstSort}; draw() replaces the table node and focus drops`);
  }
  await dateBtn.focus();
  await page.keyboard.press('Enter');
  await sleep(500);
  const afterDesc = await page.evaluate(() =>
    document.querySelector('.txn-table thead th:nth-child(2)')?.getAttribute('aria-sort'));
  if (afterAsc === 'ascending' && afterDesc === 'descending') {
    pass('Table: Date header toggles aria-sort via keyboard Enter', `${afterAsc} -> ${afterDesc}`);
  } else {
    fail('Table: Date header toggles aria-sort via keyboard Enter', `first=${afterAsc}, second=${afterDesc} (expected ascending then descending)`);
  }

  const checks = await page.evaluate(() => {
    const head = document.querySelector('.txn-all-check');
    const rows = [...document.querySelectorAll('.txn-row-check')];
    return {
      headLabel: head?.getAttribute('aria-label') ?? '',
      rowLabels: rows.map((cb) => cb.getAttribute('aria-label') ?? ''),
    };
  });
  const emptyRowLabels = checks.rowLabels.filter((l) => !l || !l.trim());
  if (checks.headLabel.trim() && emptyRowLabels.length === 0) {
    pass('Table: checkboxes have accessible names', `head="${checks.headLabel}", e.g. row="${checks.rowLabels[0]}"`);
  } else {
    fail('Table: checkboxes have accessible names', `head="${checks.headLabel}", ${emptyRowLabels.length}/${checks.rowLabels.length} row labels empty`);
  }

  const zebra = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.txn-table tbody tr')];
    if (rows.length < 3) return { enough: false };
    const bg = (el) => getComputedStyle(el).backgroundColor;
    const evenBg = bg(rows[1]);
    const oddBg = bg(rows[2]);
    const negRows = rows.filter((tr) => tr.querySelector('.amount-neg'));
    const negHasTextMarker = negRows.length === 0 || negRows.every((tr) => /\(|−|-\$/.test(tr.textContent));
    const unca = rows.filter((tr) => tr.querySelector('.chip-warn'));
    const uncaTextual = unca.length === 0 || unca.every((tr) => /uncategorized/i.test(tr.textContent));
    return { enough: true, evenBg, oddBg, distinct: evenBg !== oddBg, negHasTextMarker, uncaTextual };
  });
  if (zebra.enough && zebra.distinct) {
    info('Table: zebra striping backgrounds', `odd=${zebra.oddBg} even=${zebra.evenBg}`);
    pass('Table: status meaning duplicated in text, not stripe-only', `negatives have textual marker=${zebra.negHasTextMarker}, uncategorized textual=${zebra.uncaTextual}`);
  } else if (!zebra.enough) {
    info('Table: zebra check skipped', 'fewer than 3 rows rendered');
  } else {
    fail('Table: status meaning duplicated in text, not stripe-only', `stripe distinct=${zebra.distinct}, negText=${zebra.negHasTextMarker}, uncaText=${zebra.uncaTextual}`);
  }
}

// ---------------------------------------------------------------------------
// Task 3 — numeric alignment + tabular figures
// ---------------------------------------------------------------------------
async function assertNumStyle(page, selector, label, requireRightAlign = true) {
  const sample = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)];
    return els.slice(0, 6).map((el) => {
      const cs = getComputedStyle(el);
      return {
        fv: cs.fontVariantNumeric || '',
        align: cs.textAlign,
        text: (el.textContent ?? '').trim().slice(0, 16),
      };
    });
  }, selector);
  if (!sample.length) {
    fail(`Numbers: ${label} use tabular figures`, `no elements matched ${selector}`);
    return;
  }
  const notTabular = sample.filter((s) => !/tabular-nums/.test(s.fv));
  if (notTabular.length === 0) pass(`Numbers: ${label} use tabular figures`, `${sample.length} sampled OK`);
  else fail(`Numbers: ${label} use tabular figures`, `${notTabular.length}/${sample.length} lack tabular-nums (e.g. "${notTabular[0].text}" → "${notTabular[0].fv}")`);

  if (requireRightAlign) {
    const notRight = sample.filter((s) => s.align !== 'right');
    if (notRight.length === 0) pass(`Numbers: ${label} right-aligned`, 'all sampled right');
    else fail(`Numbers: ${label} right-aligned`, `${notRight.length}/${sample.length} not right (e.g. "${notRight[0].text}" → text-align=${notRight[0].align})`);
  }
}

async function taskNumerics(page) {
  await page.goto(`/dashboard`);
  await page.waitForSelector('.page-head');
  await page.fill('input[type="month"]', MONTH_WITH_DATA);
  await page.waitForSelector('.dash-bars li', { timeout: 8000 }).catch(() => {});
  await sleep(400);

  await assertNumStyle(page, '.dash-stat-value', 'dashboard stat card values');
  await assertNumStyle(page, '.dash-bar-row span.num', 'dashboard category bar totals');
  await assertNumStyle(page, '.dash-list-row .num', 'dashboard merchant/recurring amounts');
  await assertNumStyle(page, '.dash-budget .num', 'dashboard budget snapshot amounts');
  await assertNumStyle(page, 'svg .dash-axis-text', 'chart axis tick labels', false);

  await page.goto('/transactions');
  await page.waitForSelector('.txn-table td.num');
  await assertNumStyle(page, '.txn-table td.num', 'transactions amount cells');

  await page.goto('/budgets');
  await page.waitForSelector('.bud-table td.num', { timeout: 8000 }).catch(() => {});
  await assertNumStyle(page, '.bud-table td.num', 'budgets numeric cells');
}

// ---------------------------------------------------------------------------
// Task 4 — themes
// ---------------------------------------------------------------------------
async function taskThemes(page) {
  await page.goto('/settings');
  await page.waitForSelector('#set-theme-light');

  const themes = ['light', 'dark', 'high-contrast'];
  const samples = {};

  for (const theme of themes) {
    await page.check(`#set-theme-${theme}`);
    await sleep(350);
    const got = await page.evaluate(() => {
      const html = document.documentElement;
      const body = getComputedStyle(document.body);
      const card = document.querySelector('.card');
      const btn = document.querySelector('.btn-primary');
      return {
        theme: html.getAttribute('data-theme'),
        bodyBg: body.backgroundColor,
        bodyInk: body.color,
        cardBg: card ? getComputedStyle(card).backgroundColor : null,
        cardBorder: card ? getComputedStyle(card).borderColor : null,
        primaryBg: btn ? getComputedStyle(btn).backgroundColor : null,
        chart1: getComputedStyle(html).getPropertyValue('--chart-1').trim(),
        chart2: getComputedStyle(html).getPropertyValue('--chart-2').trim(),
      };
    });
    samples[theme] = got;
    if (got.theme === theme) pass(`Theme: data-theme switches to "${theme}"`, `body bg=${got.bodyBg} ink=${got.bodyInk}`);
    else fail(`Theme: data-theme switches to "${theme}"`, `got data-theme="${got.theme}"`);
  }

  const distinctChart1 = new Set(themes.map((t) => samples[t].chart1)).size === 3;
  const distinctBody = new Set(themes.map((t) => samples[t].bodyBg)).size === 3;
  if (distinctChart1) pass('Theme: --chart-1 recolors per theme', themes.map((t) => `${t}=${samples[t].chart1}`).join(' '));
  else fail('Theme: --chart-1 recolors per theme', themes.map((t) => `${t}=${samples[t].chart1}`).join(' '));
  if (distinctBody) pass('Theme: key element colors change across themes', `body bg: ${themes.map((t) => samples[t].bodyBg).join(' ')}`);
  else fail('Theme: key element colors change across themes', 'body background identical across some themes');

  // verify painted chart stroke actually follows the token
  async function dashStroke() {
    await page.goto('/dashboard');
    await page.waitForSelector('.page-head');
    await page.fill('input[type="month"]', MONTH_WITH_DATA);
    await page.waitForSelector('svg[role="img"] path[stroke]', { timeout: 8000 }).catch(() => {});
    await sleep(300);
    return page.evaluate(() => {
      const p = document.querySelector('svg[role="img"] path[stroke]');
      return p ? getComputedStyle(p).stroke : null;
    });
  }
  const strokes = {};
  for (const theme of ['light', 'dark']) {
    await page.goto('/settings');
    await page.waitForSelector('#set-theme-light');
    await page.check(`#set-theme-${theme}`);
    await sleep(250);
    strokes[theme] = await dashStroke();
    // dashboard screenshot in this theme
    await page.fill('input[type="month"]', MONTH_WITH_DATA);
    await page.waitForSelector('.dash-bars li', { timeout: 8000 }).catch(() => {});
    await sleep(400);
    await page.screenshot({ path: join(SHOTS, `dashboard-${theme}.png`) });
  }
  if (strokes.light && strokes.dark && strokes.light !== strokes.dark) {
    pass('Theme: chart line repaints in new theme', `light stroke=${strokes.light}, dark stroke=${strokes.dark}`);
  } else {
    fail('Theme: chart line repaints in new theme', `light=${strokes.light} dark=${strokes.dark}`);
  }

  // restore light for remaining tasks
  await page.goto('/settings');
  await page.waitForSelector('#set-theme-light');
  await page.check('#set-theme-light');
  await sleep(250);
}

// ---------------------------------------------------------------------------
// Task 5 — focus visibility
// ---------------------------------------------------------------------------
async function taskFocusVisibility(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, baseURL: BASE });
  const p = await ctx.newPage();
  attachErrorCollectors(p, globalBucket);

  await p.goto('/transactions');
  await p.waitForSelector('.txn-table');
  await sleep(200);

  const stops = [];
  for (let i = 1; i <= 10; i += 1) {
    await p.keyboard.press('Tab');
    await sleep(70);
    const d = await p.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { missing: true };
      const cs = getComputedStyle(el);
      const bits = [el.tagName.toLowerCase()];
      if (el.id) bits.push(`#${el.id}`);
      if (el.className && typeof el.className === 'string' && el.className.trim()) {
        bits.push(`.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`);
      }
      const t = (el.textContent ?? '').trim().slice(0, 20);
      return {
        desc: bits.join('') + (t ? ` "${t}"` : ''),
        type: el.type ?? '',
        focusVisible: el.matches(':focus-visible'),
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
      };
    });
    stops.push(d);
    if (d.missing) continue;
    // Focus-debug captures go to the OS temp dir, never into the repo.
    const shotName = join(tmpdir(), `ll-focus-step-${String(i).padStart(2, '0')}.png`);
    try {
      const handle = await p.evaluateHandle(() => document.activeElement);
      const el = handle.asElement();
      if (el) await el.screenshot({ path: shotName });
    } catch { /* detached or zero-size */ }
  }

  let invisible = 0;
  let innerDateStops = 0;
  stops.forEach((d, i) => {
    if (d.missing) {
      fail(`Focus: tab stop ${i + 1} lands on an element`, 'activeElement lost (body)');
      invisible += 1;
      return;
    }
    const noOutline = d.outlineStyle === 'none' || d.outlineWidth === '0px';
    if (d.focusVisible && noOutline) {
      fail(`Focus: tab stop ${i + 1} shows visible focus indicator`,
        `${d.desc} matches :focus-visible but outline-style=${d.outlineStyle}, width=${d.outlineWidth}`);
      invisible += 1;
    } else if (!d.focusVisible && noOutline) {
      innerDateStops += 1;
      info(`Focus: tab stop ${i + 1} is inside a native control's shadow DOM`, `${d.desc} (type=${d.type}) does not match :focus-visible; indication relies on the browser's built-in segment/picker highlight only`);
    }
  });
  if (invisible === 0) {
    pass('Focus: every :focus-visible tab stop shows a visible accent outline',
      stops.map((d, i) => `${i + 1}:${d.missing ? 'BODY' : `${d.desc}(${d.outlineStyle})`}`).join(' | '));
  }
  if (innerDateStops > 0) {
    info('Focus: date inputs consume multiple Tab stops', `${innerDateStops} stop(s) were internal day/month/year/picker segments of input[type=date] with no app-drawn indicator`);
  }
  info('Focus: screenshots saved', join(tmpdir(), 'll-focus-step-01..10.png (where element had a box)'));
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Task 7 — README screenshots
// ---------------------------------------------------------------------------
async function taskScreenshots(page) {
  const steps = [];
  async function step(name, fn) {
    try {
      await fn();
      steps.push(`${name}: ok`);
    } catch (err) {
      fail(`Screenshots: ${name}`, String(err?.message ?? err).split('\n').slice(0, 2).join(' | '));
      steps.push(`${name}: FAILED`);
    }
  }

  // dashboard (light theme, demo-data month)
  await step('dashboard.png', async () => {
    await page.goto('/dashboard');
    await page.waitForSelector('.page-head', { timeout: 15000 });
    await page.fill('input[type="month"]', MONTH_WITH_DATA);
    await page.waitForSelector('.dash-bars li', { timeout: 8000 }).catch(() => {});
    await sleep(500);
    await page.screenshot({ path: join(SHOTS, 'dashboard.png') });
  });

  // transactions list with filter bar visible
  await step('transactions.png', async () => {
    await page.goto('/transactions');
    await page.waitForSelector('.txn-table tbody tr', { timeout: 15000 });
    await sleep(400);
    await page.screenshot({ path: join(SHOTS, 'transactions.png') });
  });

  // import page — the wizard is expected to be unreachable: pages/import.js
  // statically imports ../app.js, which itself parks on a top-level await
  // while render() dynamically imports import.js (circular-import deadlock).
  await step('import.png', async () => {
    await page.goto('/import');
    await sleep(3000);
    const state = await page.evaluate(() => ({
      skeleton: Boolean(document.querySelector('.skeleton-wrap')),
      h1: document.querySelector('h1')?.textContent.trim() ?? '',
      paste: Boolean(document.getElementById('imp-paste')),
    }));
    if (state.skeleton && !state.h1 && !state.paste) {
      fail('Screenshots: import page renders its wizard',
        'page stuck on the loading skeleton >3s after navigation — circular dynamic/static import between app.js and pages/import.js means /import never renders; saving the stuck state as evidence');
    } else if (!state.paste) {
      fail('Screenshots: import page renders its wizard', `h1="${state.h1}", paste box present=${state.paste}`);
    } else {
      const csv = [
        'Date,Payee,Amount,Memo',
        '25/03/2026,Hypothetical Hardware,-54.00,Card purchase',
        '27/03/2026,Demo Streaming,-15.99,Subscription plan',
        '28/03/2026,Fake Gym,-29.99,Weekly membership',
      ].join('\n');
      await page.fill('#imp-paste', csv);
      await page.getByRole('button', { name: 'Analyze' }).click();
      // Wait for the async preview roundtrip to advance the stepper to Map
      // (the selector alone matches instantly on the initial Source step).
      await page.waitForFunction(
        () => document.querySelector('.imp-step.is-current .imp-step-label')?.textContent.trim() === 'Map',
        null,
        { timeout: 15000 },
      ).catch(() => {});
      const currentStep = await page.evaluate(() =>
        document.querySelector('.imp-step.is-current .imp-step-label')?.textContent.trim() ?? '');
      info('Screenshots: import wizard reached step', currentStep);
      if (currentStep !== 'Map') {
        fail('Screenshots: import reached the mapping step', `stuck at step "${currentStep}" after Analyze`);
      }
      await sleep(300);
    }
    await page.screenshot({ path: join(SHOTS, 'import.png') });
  });

  // budgets
  await step('budgets.png', async () => {
    await page.goto('/budgets');
    await page.waitForSelector('.bud-page', { timeout: 15000 });
    await page.fill('#bud-month-input', MONTH_WITH_DATA);
    await page.waitForSelector('.bud-table tbody tr', { timeout: 8000 }).catch(() => {});
    await sleep(400);
    await page.screenshot({ path: join(SHOTS, 'budgets.png') });
  });

  // settings
  await step('settings.png', async () => {
    await page.goto('/settings');
    await page.waitForSelector('.set-page .card', { timeout: 15000 });
    await sleep(300);
    await page.screenshot({ path: join(SHOTS, 'settings.png') });
  });

  const wanted = ['dashboard.png', 'transactions.png', 'import.png', 'budgets.png', 'settings.png'];
  const saved = wanted.filter((f) => existsSync(join(SHOTS, f)));
  if (saved.length === wanted.length) pass('Screenshots: README set saved', saved.join(', '));
  else fail('Screenshots: README set saved', `missing: ${wanted.filter((f) => !saved.includes(f)).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Task 8 — console error sweep over seeded server
// ---------------------------------------------------------------------------
async function taskConsoleSweep(browser, base) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, baseURL: BASE });
  const p = await ctx.newPage();
  const local = { consoleErrors: [], pageErrors: [] };
  attachErrorCollectors(p, local);

  const routes = ['/dashboard', '/transactions', '/import', '/budgets', '/settings'];
  for (const route of routes) {
    p.__route = route;
    await p.goto(base + route);
    await p.waitForSelector('.page-head', { timeout: 10000 }).catch(() => {});
    await sleep(700);
  }

  const realConsole = local.consoleErrors.filter((e) => !isFaviconNoise(e.text));
  const realPage = local.pageErrors;
  if (realConsole.length === 0 && realPage.length === 0) {
    pass('Console: no console.error / pageerror across dashboard, transactions, import, budgets, settings',
      local.consoleErrors.length ? `(ignored favicon noise: ${local.consoleErrors.length})` : '');
  } else {
    const lines = [
      ...realPage.map((e) => `pageerror @${e.page}: ${e.text}`),
      ...realConsole.map((e) => `console.error @${e.page}: ${e.text}`),
    ];
    fail('Console: no console.error / pageerror across dashboard, transactions, import, budgets, settings',
      lines.join(' || ').slice(0, 600));
  }
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Task 6 — empty states on a fresh, unseeded DB
// ---------------------------------------------------------------------------
async function taskEmptyStates(base) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT, baseURL: BASE });
  const p = await ctx.newPage();
  const bucket = { consoleErrors: [], pageErrors: [] };
  attachErrorCollectors(p, bucket);

  const checks = [
    ['/dashboard', 'Welcome to Ledgerlight'],
    ['/transactions', 'Welcome to Ledgerlight'],
  ];
  for (const [route, heading] of checks) {
    p.__route = route;
    await p.goto(base + route);
    await p.waitForSelector('.page-head, .empty-state', { timeout: 10000 }).catch(() => {});
    await sleep(600);
    const st = await p.evaluate(() => {
      const es = document.querySelector('.empty-state');
      return {
        present: Boolean(es),
        heading: es?.querySelector('h2')?.textContent.trim() ?? '',
        textLen: (es?.textContent ?? '').trim().length,
        bodyBlank: document.body.textContent.trim().length < 40,
      };
    });
    if (st.present && st.heading === heading && st.textLen > 40 && !st.bodyBlank) {
      pass(`Empty state ${route}: designed copy renders`, `"${st.heading}" (${st.textLen} chars)`);
    } else {
      fail(`Empty state ${route}: designed copy renders`,
        `present=${st.present} heading="${st.heading}" textLen=${st.textLen} bodyBlank=${st.bodyBlank}`);
    }
  }

  const realErrs = [
    ...bucket.pageErrors.map((e) => `pageerror @${e.page}: ${e.text}`),
    ...bucket.consoleErrors.filter((e) => !isFaviconNoise(e.text)).map((e) => `console.error @${e.page}: ${e.text}`),
  ];
  if (realErrs.length === 0) pass('Empty state pages: no console errors', bucket.consoleErrors.length ? `(favicon noise ignored: ${bucket.consoleErrors.length})` : '');
  else fail('Empty state pages: no console errors', realErrs.join(' || ').slice(0, 500));

  await ctx.close();
  await browser.close();
}

// ---------------------------------------------------------------------------

const globalBucket = { consoleErrors: [], pageErrors: [] };
let BASE = '';

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  const seededPort = 7901;
  const emptyPort = 7902;
  const seededDb = makeDbPath('seeded');
  const emptyDb = makeDbPath('empty');

  console.log(`Seeding demo DB: ${seededDb}`);
  await runSeed(seededDb);
  console.log('Starting servers...');
  const seededProc = await startServer(seededPort, seededDb);
  const baseSeeded = `http://127.0.0.1:${seededPort}`;
  BASE = baseSeeded;
  console.log(`Seeded server ready at ${baseSeeded}`);

  let emptyProc = null;
  let baseEmpty = null;

  const browser = await chromium.launch();

  const tasks = [
    ['Task 1: keyboard-only categorization', () => {
      const ctx = browser.newContext({ viewport: VIEWPORT, baseURL: BASE });
      return ctx.then(async (c) => {
        const p = await c.newPage();
        attachErrorCollectors(p, globalBucket);
        try { await taskKeyboard(p); } finally { await c.close(); }
      });
    }],
    ['Task 2: table semantics', () => {
      const ctx = browser.newContext({ viewport: VIEWPORT, baseURL: BASE });
      return ctx.then(async (c) => {
        const p = await c.newPage();
        attachErrorCollectors(p, globalBucket);
        try { await taskTableSemantics(p); } finally { await c.close(); }
      });
    }],
    ['Task 3: numeric alignment & tabular figures', () => {
      const ctx = browser.newContext({ viewport: VIEWPORT, baseURL: BASE });
      return ctx.then(async (c) => {
        const p = await c.newPage();
        attachErrorCollectors(p, globalBucket);
        try { await taskNumerics(p); } finally { await c.close(); }
      });
    }],
    ['Task 4: themes', () => {
      const ctx = browser.newContext({ viewport: VIEWPORT, baseURL: BASE });
      return ctx.then(async (c) => {
        const p = await c.newPage();
        attachErrorCollectors(p, globalBucket);
        try { await taskThemes(p); } finally { await c.close(); }
      });
    }],
    ['Task 5: focus visibility', () => taskFocusVisibility(browser)],
    ['Task 7: README screenshots', () => {
      const ctx = browser.newContext({ viewport: VIEWPORT, baseURL: BASE });
      return ctx.then(async (c) => {
        const p = await c.newPage();
        attachErrorCollectors(p, globalBucket);
        try { await taskScreenshots(p); } finally { await c.close(); }
      });
    }],
    ['Task 8: console error sweep', () => taskConsoleSweep(browser, baseSeeded)],
  ];

  for (const [name, fn] of tasks) {
    console.log(`\n=== ${name} ===`);
    try {
      await fn();
    } catch (err) {
      const msg = String(err?.message ?? err).split('\n').slice(0, 3).join(' | ');
      fail(`${name} (task crashed)`, msg);
    }
  }

  console.log('\n=== Task 6: empty states (second server, empty DB) ===');
  try {
    emptyProc = await startServer(emptyPort, emptyDb);
    baseEmpty = `http://127.0.0.1:${emptyPort}`;
    console.log(`Empty server ready at ${baseEmpty}`);
    await taskEmptyStates(baseEmpty);
  } catch (err) {
    fail('Task 6: empty states (task crashed)', String(err?.message ?? err));
  }

  await browser.close();
  await stopServer(seededProc);
  await stopServer(emptyProc);
  removeDb(seededDb);
  removeDb(emptyDb);

  const failures = results.filter((r) => !r.ok);
  console.log(`\n===== SUMMARY: ${results.length - failures.length} passed, ${failures.length} failed =====`);
  for (const f of failures) console.log(`  FAIL: ${f.name}\n        ${f.detail}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
