# Ledgerlight — Design

## Point of view

Ledgerlight should feel like a well-made accounting ledger that learned some editorial
restraint: quiet paper-toned surfaces, one accent used sparingly for state and focus,
numbers set like they matter because they do. Hierarchy comes from typography, weight
and alignment — never from decoration. The reference register is a clean annual-report
data page, not a fintech startup: no neon gradients, no oversized rounded cards, no
sparkle effects on balances. Every screen answers one question at a glance and stays
out of the way the rest of the time. Trust is the aesthetic: consistent alignment,
honest empty states, numbers you can scan down a column and add in your head.

## Banned (permanent)

- Purple-blue gradient headers; glassmorphism; drop shadows on every card.
- Emoji anywhere in UI chrome or as category icons.
- Default framework indigo as the accent.
- Numbers set in proportional figures; misaligned decimal points.
- Pie/doughnut charts with more than six slices; 3D anything.
- Animated count-ups on money figures; gratuitous value transitions.

## Typography

| Role | Stack | Notes |
|------|-------|-------|
| UI + body | `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | One family everywhere |
| Numbers (all amounts, all tables, axis ticks) | Same family with `font-variant-numeric: tabular-nums lining-nums` | Class `.num`. **Every amount is tabular and right-aligned. No exceptions.** |
| Mono (fingerprints, file paths) | `ui-monospace, "Cascadia Code", Consolas, monospace` | Diagnostics only |

Scale: 12 (labels/captions), 13.5 (table body), 14 (body), 16 (emphasis), 20 (section),
28/600 (page title). Line-height 1.45 body, 1.2 headings. Page title weight 600, never
bolder; hierarchy via size and spacing, not shouting.

## Number formatting (chosen once)

- Amounts stored as integer minor units; formatted via `formatMoney`.
- Currency symbol before amount, single space after symbol (`$ 1,234.56`) — set by
  settings (`symbolSide: left|right`).
- Negatives: **parentheses**, accounting style — `$ (1,234.56)` with symbol placement
  preserved inside the parens. Chosen once, used everywhere in the UI (charts,
  tooltips, tables). Export files use plain signed numbers for machine reading.
- Thousands separators on from 1,000 up. No abbreviation under 100,000; axes may
  abbreviate to `$ 12k`, `$ 1.2m` (one decimal max) when tick density requires.
- Zero renders `0.00` (never `–` or `—` in numeric columns).
- Percentages: integer percent with explicit sign for deltas (`+12%`, `−8%`); delta
  arrows `▲▼` accompany signs so colour is never the only signal.
- Dates: ISO-like display order follows settings (`dmy|mdy|ymd`), zero-padded,
  e.g. `2026-08-22` / `22 Aug 2026` short form for tables.

## Colour tokens (role-based)

Tokens live in `scripts/tokens.mjs` (source of truth) and are compiled to
`public/css/tokens.css`. Themes are pure token overrides: `light` (default), `dark`,
`high-contrast`.

| Token | Role | Light | Dark | High-contrast |
|-------|------|-------|------|---------------|
| `bg` | App background | `#f7f6f3` | `#14161a` | `#ffffff` |
| `surface` | Cards, panels | `#fffefb` | `#1d2025` | `#ffffff` |
| `surface-sunken` | Table zebra / wells | `#f1efe9` | `#171a1f` | `#f0f0f0` |
| `border` | Hairlines, dividers | `#d9d5cc` | `#33383f` | `#767676` |
| `border-strong` | Focusable borders | `#b5afa2` | `#4a505a` | `#000000` |
| `ink` | Primary text | `#1e1c18` | `#e8eaed` | `#000000` |
| `ink-secondary` | Secondary text | `#57534a` | `#a8adb5` | `#1a1a1a` |
| `ink-faint` | Captions, axis ticks* | `#6e6960` | `#8f959e` | `#333333` |
| `accent` | Interactive/focus | `#0b6b4f` | `#3ecf9a` | `#005a3c` |
| `accent-ink` | Text on accent | `#ffffff` | `#06130e` | `#ffffff` |
| `negative` | Expenses, over budget | `#a02c2c` | `#ff7b72` | `#a80000` |
| `positive` | Income | `#1a7f37` | `#4ec96a` | `#005a1e` |
| `warning` | Attention (not error) | `#8a5a00` | `#d9a53f` | `#5c3d00` |
| `selection` | Row selection bg | `#e4efe9` | `#20342c` | `#d6ecd9` |

*Axis ticks use `ink-faint` and must still pass AA against `bg` — verified by test.

Semantics: expenses/negative = `negative`; income/positive = `positive`; over-budget =
`negative` **plus** an `▲ Over` glyph-label chip; uncategorized = `warning` chip plus
the word "Uncategorized". Colour alone never carries status.

## Chart palette

Separate from UI palette; ordered for categorical series. Verified pairwise-distinct
under deuteranopia simulation by automated test (`test/design-tokens.test.mjs`).

| Order | Light | Dark | High-contrast |
|-------|-------|------|---------------|
| 1 | `#0b6b4f` | `#3ecf9a` | `#005a3c` |
| 2 | `#b5651d` | `#e0975a` | `#7a3e00` |
| 3 | `#31597e` | `#7ab3de` | `#0f3d66` |
| 4 | `#6b4fa1` | `#b39ae0` | `#46277d` |
| 5 | `#a03a5c` | `#e07f9f` | `#75002c` |
| 6 | `#5f6b23` | `#aeb85e` | `#3c4200` |

Beyond six series, categories collapse into "Other" (bar charts list top N + Other;
no pie ever exceeds six slices). Uncategorized is always drawn in `ink-faint` hatch or
gray — never a palette hue — so it reads as "missing data", not a category.

## Chart rules

- Axes: single hairline baseline (`border`), no box frame. Y gridlines: 1px dashed
  `border` at ≤5 ticks, labels in `ink-faint` 12px tabular nums, right-aligned to axis.
- Labels: no label rotation; if x labels collide, thin by integer steps (every 2nd/3rd).
- Tooltips: `surface` bg, `border-strong` hairline, title = period/name, rows = label +
  right-aligned tabular amount, delta line when comparison exists. No shadows.
- Bars have flat fills, no gradients, no rounded corners beyond 1px; gap ≥ 25% of bar width.
- Line charts: 2px stroke, no area fill unless comparing two series; points only on hover.
- Explicit bans: 3D, doughnut > 6 slices, animated count-ups, dual y-axes.
- Motion: transitions ≤150ms opacity/transform only; honoured `prefers-reduced-motion`.

## Tables

- Density: compact — row height 32px (40px touch targets on interactive cells), cell
  padding 8px vertical.
- Zebra vs border decision: **zebra** (`surface-sunken` on even rows) with a single
  header underline (`border-strong`); no vertical rules except column-group separators
  in split editor.
- Alignment: text left, amounts right (tabular), dates left (fixed-width), counts right.
- Sortable columns: header is a button showing `▲/▼` indicator + `aria-sort`; unsorted
  shows a faint `↕`. Sort is stable and re-runs without page reload.
- Screen readers: real `<table>` with `<caption>`, `<th scope="col">`, `aria-sort`,
  row headers where applicable; bulk actions announced via `aria-live="polite"` region.

## States (designed, not afterthoughts)

- **No accounts**: centered panel explaining what Ledgerlight does + primary CTA
  "Import your first CSV" + secondary "Add account manually". No fake data.
- **No transactions**: per-account message with import CTA and sample-import hint
  (`scripts/gen-fixtures.mjs` files are safe synthetic data).
- **No budget set**: budget card shows "No budget for {category}" with inline
  "Set monthly budget" affordance; dashboards omit budget widgets entirely rather
  than render zeros.
- **No filter results**: "No transactions match" + active-filter chips each with an ✕
  to remove + "Clear all filters".
- **Loading**: skeleton rows for lists; imports show real progress bar with parsed /
  categorized / failed counters and Cancel (atomic rollback). Never indeterminate
  spinners for known-size work.
- **Error**: inline field errors for mapping; toast + failure ledger for runtime
  errors; every error names the row/reason where applicable.
- **Partial data**: dashboard cards whose month has incomplete coverage show
  "Partial — N days" caption; never silently present partial months as full.

## Accessibility commitments

- Visible focus ring: 2px `accent` outline offset 2px, everywhere, never removed.
- Full keyboard operation: transaction list roving tabindex (`j/k`, arrows, space
  select, `1–9` quick categories, `c` picker, `enter` commit+advance, `?` shortcuts);
  all dialogs focus-trapped with Esc; skip-to-content link.
- Contrast AA minimum for all text including axis ticks, chart labels, chips — verified
  programmatically per theme in tests.
- Status never by colour alone (glyph + text label always).
- `prefers-reduced-motion` respected globally.
