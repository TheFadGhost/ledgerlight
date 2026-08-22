import { detectDelimiter } from './detect.js';

/**
 * RFC4180-style CSV parser.
 * - Quoted fields with "" escapes; commas and newlines allowed inside quotes.
 * - CRLF and LF row endings; trailing newline optional (no phantom row).
 * - Empty lines are skipped; a line of only separators is kept as empty fields.
 * Returns { rows: string[][], delimiter }.
 */
export function parseCsv(text, { delimiter = null } = {}) {
  const src = String(text ?? '');
  const delim = delimiter === null ? detectDelimiter(src) : delimiter;

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  let rowHasContent = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const finishRow = () => {
    pushField();
    if (!rowHasContent && row.length === 1 && row[0] === '') {
      // Physically empty line: skip it, never fabricate a row.
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      rowHasContent = true;
      i += 1;
    } else if (ch === delim) {
      pushField();
      atFieldStart = true;
      rowHasContent = true;
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      finishRow();
      atFieldStart = true;
      rowHasContent = false;
      i += 1;
    } else {
      field += ch;
      atFieldStart = false;
      rowHasContent = true;
      i += 1;
    }
  }
  finishRow();

  return { rows, delimiter: delim };
}
