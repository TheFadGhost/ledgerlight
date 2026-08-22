# Ledgerlight — Plan

Mission: a local personal finance tracker that imports bank CSV exports, categorizes
transactions automatically, and presents spending clearly — for someone who wants to
understand their own money without uploading it to a service.

Scope fences (second products, permanently out): bank API sync, multi-currency/FX,
investment or net-worth tracking, tax filing/codes, multi-user accounts, financial advice.

## Accepted

| # | Feature | Reason |
|---|---------|--------|
| A1 | Guided first-import onboarding (empty state → import → mapping → first dashboard) | The first import is the product's front door; empty states must route into it |
| A2 | Named import profiles per bank (delimiter, encoding, header row, date format, column map) | Turns every subsequent import of the same format into one click; core mission item |
| A3 | Explicit DD/MM vs MM/DD ambiguity gate with side-by-side preview | Flipped months silently corrupt every trend; never guess dates |
| A4 | Date-format memory inside the profile, re-gated on contradiction | Re-asking an answered question erodes trust |
| A5 | Real-count import progress ("Parsed 6,400 / 18,212 · 12 failed") | Silence during long imports reads as hung; users must see every row accounted for |
| A6 | Atomic imports: single SQLite transaction, cancel rolls back everything | Half-imported months poison reports; partial data never persists |
| A7 | Failure ledger: skipped/unparsed rows listed with row number and reason | Never silently drop rows it could not parse |
| A8 | Rules tester: preview matching transactions before saving a rule | Makes rules trustworthy instead of a blind slot machine |
| A9 | Correction-in-context: recategorizing shows which rule fired and offers "remember for this merchant" | Learning must be visible and reversible |
| A10 | Keyboard-first transaction list (j/k navigate, space select, 1–9 pinned categories, c picker, enter commits+advances) | Categorization is the core act; friction here is the product |
| A11 | Merchant-aware quick-pick ordering (categories used for this merchant first) | Reorders honestly; never guesses |
| A12 | Bounded action-level undo (last ~20 bulk actions, ctrl+z + toast), category changes and splits only | Bulk edits without undo make people afraid to clean data |
| A13 | Inline split editor with live "remaining" residue, one level deep | Real life spans categories in one purchase; totals must stay exact |
| A14 | Recurring-payment detector, annotation-only (cadence, median amount, stability band, next expected) | Subscriptions are the classic leak; detect and display, never act |
| A15 | Period comparison: vs previous month and trailing 3-month average per category | "Am I spending more than usual?" is the question the app exists to answer |
| A16 | Uncategorized prominence: persistent chip linking to filtered list; explicit gray segment | Unknown money corrupts every downstream insight |
| A17 | Display settings done once: symbol position, separators, negative style, date order; single currency | Misformatted numbers destroy trust instantly |
| A18 | Committed table accessibility contract (real tables, aria-sort, roving tabindex, aria-live status, no colour-only status) | The table IS the app |
| A19 | Default taxonomy: ~15 leaves under 5 groups incl. excluded-from-spend Transfers group | Keeps credit-card payments out of spend totals; honest generic banks |
| A20 | Budgets per category per month with progress + explicit over-budget glyph/label | Mission-required; kept deliberately minimal (no rollover, no goals) |

## Rejected

| # | Feature | Reason |
|---|---------|--------|
| R1 | Resumable/checkpointed imports | Local files re-import in seconds; checkpoint bookkeeping is complexity theater |
| R2 | Shadowed-rule auditor panel | Rules tester already surfaces conflicts at authoring time; auditor flatters the builder |
| R3 | Goals, savings targets, rollover budgets | Describes what you *should* spend, not what you *did*; planning ≠ understanding |
| R4 | Multi-currency / FX conversion | Needs rate tables or network; single currency enforced by design |
| R5 | Net worth / asset tracking | Valuation logic is a second product |
| R6 | Bank API / open-banking sync | Violates local-only core purpose |
| R7 | Investment portfolio tracking | Second product |
| R8 | Tax categorization / reports | Jurisdiction-dependent second product |
| R9 | Receipts / OCR attachments | Scope creep away from CSV-led workflow |
| R10 | Multi-user accounts / shared households | Auth model is a second product |

## Build order

1. Contracts I own personally: integer-minor-unit money module, strict date module,
   schema + migrations (`docs/DATA-MODEL.md`).
2. Design tokens + themes generated from a token source of truth (before any UI code).
3. Storage layer → CSV parse/detect/profiles → dedupe → rules engine → analytics.
4. API routes → UI shell consuming tokens → import wizard → transaction table →
   dashboard/charts → budgets → settings/themes → backup/restore.
5. Fixture generator (≥8 synthetic formats) + full test suite; regression gate every round.
6. v0.1.0 release when import→categorize→dashboard works end to end.
7. Audit by non-author agents → AUDIT.md fixes → re-audit → v1.0.0.
