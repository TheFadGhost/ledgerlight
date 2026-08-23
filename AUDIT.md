# Ledgerlight — Audit record (pre-v1.0.0)

Audits performed by sub-agents that did not write the code they audited:
a read-only code audit and a live-browser design/UX audit (Playwright, real
keyboard interaction, computed-style checks). Automated gates added during the
process: `test/design-tokens.test.mjs` (WCAG AA contrast for every theme pair
including axis ticks; deuteranopia-simulated pairwise ΔE ≥ 12 on every chart
palette) and `scripts/ui-smoke.mjs` (48 browser checks).

Final status at v1.0.0: **all BLOCKER/MAJOR findings fixed; MINOR items either
fixed or explicitly dispositioned below. Suite 148/148; ui-smoke 47 pass / 0 fail.**

## Design audit — findings & dispositions

| ID | Finding | Disposition |
|----|---------|-------------|
| B1 | `/import` never rendered: circular import deadlock between `app.js` top-level await and the page's static import of it | FIXED — boot no longer awaits at module evaluation; verified by ui-smoke |
| M1 | Transaction keyboard shortcuts dead from initial focus (handler bound to child of focused element) | FIXED — document-level binding with typing-context guards |
| M2 | Dialogs focused their close button first | FIXED — focus priority is field → action button → overlay |
| M3 | Enter did not commit categorization in pickers | FIXED — select commits on Enter everywhere a picker commits |
| M4 | Sorting ejected keyboard focus to `<body>` | FIXED — focus restored to the activating control after redraw |
| m1 | Dashboard stat amounts left-aligned | FIXED |
| m2 | Native date inputs have weak visible focus | FIXED — explicit accent outline rule |
| m3 | Hover indistinguishable from selection | FIXED — selected rows carry an inset accent edge |
| n1 | Hidden bulk bar wrote "0 selected" while hidden | FIXED — writes skipped while hidden |

## Code audit — findings & dispositions

| ID | Finding | Disposition |
|----|---------|-------------|
| M1 | Dead 64 MB check (1 MB body cap), commit unchecked, restore capped at 1 MB | FIXED — single 80 MB body limit, shared content guard on preview+commit, restore size guard |
| M2 | Body-parser/router errors surfaced as 500 INTERNAL | FIXED — typed handler maps 413/400 with stable codes |
| M3 | Importer silently disabled auto-categorization via require-of-ESM fallback outside supported Node range | FIXED — static import; dead fallback removed with its tests |
| M4 | Garbage numeric query params bound as NULL → silent empty results or 500s; PUT /budgets never validated categoryId | FIXED — strict integer param coercion (400 INVALID_PARAM) + categoryId existence check |
| M5 | DELETE /budgets/:id returned 500 for missing budget | FIXED — 404 with standard error shape |
| M6 | Rules page unreachable from navigation | FIXED — Rules added to main nav |
| M7 | Three client pages parsed money with float arithmetic (contract violation; guarded so no corruption demonstrable) | FIXED — shared BigInt-only `public/js/money.js`; all client money parsing now exact |
| min1 | Fractional ?limit crashed queries | FIXED — integer clamping |
| min2 | bulkCategorize reported ids.length including missing rows | FIXED — reports actual matched rows |
| min5 | Undo entry written outside its transaction | FIXED — undo + mutation share one transaction |
| min6 | Prepare-per-row waste in popUndo/restoreBackup | FIXED — hoisted/cached statements |
| min15 | No busy_timeout → SQLITE_BUSY when seeding while server runs | FIXED — PRAGMA busy_timeout = 5000 |
| min14 | docs/DATA-MODEL.md API drift | FIXED — API section rewritten to match implementation |

## Accepted limitations (documented, deliberate)

- **Regex ReDoS surface**: user-supplied regexes run synchronously against
  ≤500-char inputs (rules) / raw CSV lines (skip patterns). A catastrophic
  pattern could stall this single-threaded local process. Accepted for a
  localhost, single-user tool; length caps and try/catch bound the common cases.
- **Whole-buffer imports**: files are parsed in memory (bounded by the 64 MB
  content cap). Streaming parsing was rejected as unjustified complexity at
  personal-finance scale.
- **`TypeError`/`RangeError` map to HTTP 400** globally: validation-heavy API;
  the tradeoff is that genuine internal type bugs surface as client errors.
- **`listAccounts` returns snake_case columns**: kept because clients consume
  them; documented boundary inconsistency rather than a breaking rename.
- **Local vs UTC "today"**: client date entry uses local time, dashboard month
  default uses UTC. Divergence only within hours of month boundaries.
- **Manual-entry duplicate scan is O(rows-in-account)** per insert: fine at
  personal scale (tens of thousands of rows).
- **Recurring `stabilityPct` uses one float division** for a display-only
  0–100 label (never money); band detection itself is pure integer math.

## Verification trail

- `npm test` — 148 tests, all passing (money exactness incl. large-sum drift
  probes, 10 synthetic bank fixtures, DD/MM-vs-MM/DD rejection path,
  dedup occurrence semantics, rules precedence/safety/learning, recurring
  detector vs noise, budget boundaries, backup round-trip equality,
  split-aware aggregation consistency, token contrast + deuteranopia).
- `node scripts/ui-smoke.mjs` — 48 browser checks passing (keyboard-only
  categorization end to end, aria-sort/table semantics, tabular-figure +
  right-alignment sweeps, three-theme switching with chart recolor, focus
  visibility walk, empty states, console-error sweep, README screenshots).
- Fresh-clone rehearsal: clean install → `npm start` → README steps followed
  as a stranger; fixture import through the wizard verified in-browser.
