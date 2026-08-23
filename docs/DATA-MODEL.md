# Ledgerlight — Data model (shared contract)

Every module must code against these definitions. The owner of this contract is the
project lead; changes require updating this file and all consumers in the same commit.

## Money

- All amounts are **integers in minor units** (cents for USD/EUR/GBP).
- No binary float may touch a monetary value anywhere — parsing, storage,
  aggregation, chart math included. `src/core/money.js` is the only parser/formatter.
- Sign convention: **expenses are negative, income is positive**, as exported by
  banks in signed single-column formats. Separate debit/credit columns are merged at
  import time into this convention. Splits carry signed amounts that must sum exactly
  to their parent transaction's amount.
- Display formatting: parentheses negatives, symbol placement per settings
  (`formatMoney`). Export files use plain signed numbers (`exportMoney`).

## Dates

- Stored as `'YYYY-MM-DD'` strings. Parsing only via `src/core/dates.js`.
- DD/MM vs MM/DD ambiguity is resolved by explicit user choice during mapping and
  persisted in the import profile; detection reports ambiguity but never picks.

## Database

Single SQLite file via `node:sqlite`. Default location:
`<repo>/data/ledgerlight.db` (gitignored). Override with `LEDGERLIGHT_DB` env var.
Schema version tracked in `meta(schema_version)`; migrations are sequential functions
in `src/core/db.js`.

### Tables

```
accounts        id PK · name UNIQUE NOT NULL · type ('checking'|'savings'|'credit'|'cash') · currency 'USD' · opening_balance_minor INT ≥ 0 default 0 · created_at ISO datetime
categories      id PK · name NOT NULL · parent_id → categories.id NULLable · kind ('group'|'expense'|'income') · exclude_from_spend INT default 0 (Transfers) · system INT default 0 · sort_order INT
transactions    id PK · account_id → accounts ON DELETE CASCADE · date 'YYYY-MM-DD' · payee TEXT NOT NULL · description TEXT · amount_minor INT NOT NULL · category_id → categories NULLable · category_source ('rule'|'learned'|'manual'|'imported'|'none') · applied_rule_id → rules · fingerprint TEXT NOT NULL · notes TEXT · manual INT 0|1 · created_at
                CHECK: category_source IS NULL ⇔ category_id IS NULL; when source='manual', applied_rule_id NULL
splits          id PK · transaction_id → transactions ON DELETE CASCADE · amount_minor INT · category_id → categories · note TEXT   (children sum == parent amount_minor)
rules           id PK · priority INT (lower runs first) · name TEXT · match_type ('substring'|'regex'|'amount_range'|'any') · pattern TEXT · min_amount_minor INT? · max_amount_minor INT? · account_id → accounts? · category_id → categories NOT NULL · source ('user'|'learned') · enabled INT 1 · created_at
                learned rules evaluate BEFORE user rules (priority space −1000+)
profiles        id PK · name UNIQUE · delimiter · encoding · header_row INT · date_format ('dmy'|'mdy'|'ymd') · date_column resolved at map time · column_map JSON · amount_mode ('signed'|'split_dc'|'inflow_outflow') · skip_patterns JSON · updated_at
import_files    id PK · filename · profile_id? · imported_at · row_count · imported_count · skipped_count · error_count · details JSON (skip/error ledger)
budgets         id PK · category_id UNIQUE → categories · monthly_amount_minor INT > 0 · enabled INT 1
settings        key PK · value JSON text   (theme, display currency/format, week start)
undo_log        id PK DESC order · action_type ('bulk_categorize'|'split'|'unsplit') · payload JSON (inverse operation) · created_at
meta            key PK ('schema_version', …)
```

### Fingerprint & deduplication

`fingerprint = sha256( account_id | date | amount_minor | normalized(payee + description) )`
hex, computed in `src/dedupe.js`. Normalization = lowercase, collapse whitespace,
strip punctuation noise. `UNIQUE(account_id, fingerprint)` enforced.

Re-import overlap rule (count-difference): per fingerprint group with K rows in DB
and M rows incoming, insert `max(0, M−K)` rows, skip `min(K,M)` reporting each skip
with reason `duplicate`. Two genuinely distinct same-day same-amount purchases from
the same merchant survive because the file containing both has M=2 > K.

### Rules evaluation order

1. Transaction manually categorized (`category_source='manual'`) is never re-categorized.
2. Learned rules (source='learned'), most recently learned first.
3. User rules ascending by priority, then id.
4. First match wins; match recorded via `applied_rule_id`, source 'rule'.
5. No match → uncategorized (`category_id NULL`, source NULL), surfaced prominently.

Regex safety: patterns compiled once; length cap 200 chars; invalid regexes rejected
at save; matching input truncated to 500 chars before test.

### API surface (REST, localhost only)

```
GET/POST/PATCH/DELETE /api/accounts
GET/POST/PATCH /api/categories
GET /api/transactions (filters: q, account_id, category_id, from, to, min, max, uncategorized, sort, dir, limit, offset)
PATCH /api/transactions/:id   (category override -> learns)
POST /api/transactions/bulk   {ids, categoryId, remember?}
POST /api/transactions/:id/split  {parts:[{amountMinor, categoryId?, note}]}   (sum must equal parent exactly)
DELETE /api/transactions/:id/split
POST /api/transactions/manual
POST /api/import/preview      {content: csvText, profileId?, overrides?} -> detection + parsed preview + ambiguities
POST /api/import/commit       {content, accountId|accountName, dateFormat?, profileId?} -> atomic import, ledger report
GET/POST/PATCH/DELETE /api/profiles
GET/POST/PATCH/DELETE /api/rules       POST /api/rules/test {draft} → matched txns
GET /api/dashboard?month=YYYY-MM
GET /api/recurring
GET/PUT/DELETE /api/budgets
GET /api/settings  PUT /api/settings
POST /api/undo              undo last logged action
GET /api/export.csv /api/export.json
GET /api/backup             full JSON backup · POST /api/restore
GET /api/meta               db path, version, counts
```
