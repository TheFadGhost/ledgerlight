# Ledgerlight

A local personal finance tracker for people who want to understand their own spending by importing bank CSV exports — without uploading a single row to anyone's cloud.

**All data stays on your machine**, in one SQLite file you control: `data/ledgerlight.db` inside the folder where you run Ledgerlight (override the location with the `LEDGERLIGHT_DB` environment variable). Nothing is transmitted anywhere; the app runs as a localhost web server and has no outbound network calls.

Ledgerlight offers no financial advice and makes no predictions. It counts what happened.

## Install

Requires Node.js 22.5 or newer.

```sh
npm install
npm start
```

Open http://localhost:7781 in your browser.

## Import your first CSV

1. Open the **Import** page.
2. Choose a file (or paste CSV text). Try the included synthetic sample:

   ```sh
   npm run gen:fixtures   # writes fixtures/*.csv - obviously fake demo data
   ```

3. Ledgerlight detects encoding, delimiter, header row, date format and amount style. When dates are ambiguous (`03/04/2026`), **you choose DD/MM or MM/DD explicitly** — it never guesses.
4. Map columns to fields, optionally save the mapping as a named profile per bank. Next month's export of the same format is one click.
5. Review parsed rows, pick an account, import. Rows that could not parse are listed with row numbers and reasons — nothing is silently dropped.

Re-importing overlapping statements is safe: transactions are fingerprinted, duplicates are skipped and reported.

## Auto-categorization rules

Rules are evaluated top to bottom; learned rules (from your manual corrections) take precedence. Match types:

- `substring` — payee/description contains text (case-insensitive)
- `regex` — regular expression against payee + description
- `amount_range` — amount between two bounds (minor units = cents)
- `any` — matches everything

The rule editor has a live tester showing exactly which existing transactions a draft would match before you save it. Recategorize any transaction manually; the app can remember your choice per merchant.

## Keyboard

In the transaction list: `j`/`k` navigate, `space` selects, `c` recategorizes, `enter` opens details, `1`–`9` assign recent categories, `?` shows all shortcuts, `Ctrl+Z` undoes the last bulk action.

## Architecture note

Single-process Node.js server (`server/`, Express) serving a no-build vanilla-JS frontend (`public/`). Domain logic lives dependency-free under `src/`: strict money parsing into integer minor units (floats are never used for money), strict date parsing, CSV decode/parse/detect, deduplication fingerprints, rules engine, analytics (aggregations, recurring-payment detector, budgets), backup/restore. SQLite via Node's built-in `node:sqlite`. Tests: `npm test`.

## Commands

```sh
npm start          # run the app (http://localhost:7781)
npm test           # full test suite
npm run gen:tokens # regenerate theme CSS from scripts/tokens.mjs
npm run gen:fixtures # generate synthetic CSV fixtures
npm run seed       # --db path/to/file.db seeds a demo database from fixtures
```

## License

[MIT](LICENSE)
