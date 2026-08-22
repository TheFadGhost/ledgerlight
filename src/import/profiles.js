const DELIMITERS = [',', ';', '\t', '|'];
const ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'];
const DATE_FORMATS = ['dmy', 'mdy', 'ymd'];
const AMOUNT_MODES = ['signed', 'split_dc', 'inflow_outflow'];
const COLUMN_FIELDS = ['date', 'amount', 'debit', 'credit', 'payee', 'description'];

function fail(message) {
  throw new TypeError(`profile config invalid: ${message}`);
}

function validateColumnMap(map, amountMode) {
  if (map == null || typeof map !== 'object' || Array.isArray(map)) {
    fail("'columnMap' must be an object mapping field -> column index");
  }
  const fields = Object.keys(map);
  for (const f of fields) {
    if (!COLUMN_FIELDS.includes(f)) fail(`unknown columnMap field '${f}' (allowed: ${COLUMN_FIELDS.join(', ')})`);
    if (!Number.isInteger(map[f]) || map[f] < 0) fail(`columnMap.${f} must be a non-negative integer`);
  }
  if (!fields.includes('date')) fail("columnMap requires a 'date' field");
  const hasAmount = fields.includes('amount');
  const hasDebit = fields.includes('debit');
  if (!hasAmount && !hasDebit) fail("columnMap requires 'amount' or 'debit'");
  if ((amountMode === 'split_dc' || amountMode === 'inflow_outflow') && !hasDebit) {
    fail(`amountMode '${amountMode}' requires columnMap.debit (credit optional)`);
  }
  if (amountMode === 'signed' && !hasAmount) {
    fail("amountMode 'signed' requires columnMap.amount");
  }
}

export function validateProfileConfig(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    fail('expected an object');
  }
  const {
    name,
    delimiter,
    encoding = 'utf-8',
    headerRow = 0,
    dateFormat,
    columnMap,
    amountMode = 'signed',
    skipPatterns = [],
  } = input;

  if (typeof name !== 'string' || name.trim() === '') fail("'name' must be a non-empty string");
  if (!DELIMITERS.includes(delimiter)) fail(`'delimiter' must be one of ${JSON.stringify(DELIMITERS)}`);
  if (typeof encoding !== 'string' || !ENCODINGS.includes(encoding.toLowerCase())) {
    fail(`'encoding' must be one of ${JSON.stringify(ENCODINGS)}`);
  }
  if (!Number.isInteger(headerRow) || headerRow < 0) fail("'headerRow' must be a non-negative integer");
  if (!DATE_FORMATS.includes(dateFormat)) fail(`'dateFormat' must be one of ${JSON.stringify(DATE_FORMATS)}`);
  if (!AMOUNT_MODES.includes(amountMode)) fail(`'amountMode' must be one of ${JSON.stringify(AMOUNT_MODES)}`);
  validateColumnMap(columnMap, amountMode);
  if (!Array.isArray(skipPatterns) || skipPatterns.some((p) => typeof p !== 'string')) {
    fail("'skipPatterns' must be an array of strings");
  }

  return {
    name,
    delimiter,
    encoding: encoding.toLowerCase(),
    headerRow,
    dateFormat,
    columnMap: { ...columnMap },
    amountMode,
    skipPatterns: [...skipPatterns],
  };
}

function hydrate(row) {
  if (!row) return row;
  let columnMap = {};
  let skipPatterns = [];
  try {
    columnMap = JSON.parse(row.column_map ?? '{}');
  } catch {
    columnMap = {};
  }
  try {
    skipPatterns = JSON.parse(row.skip_patterns ?? '[]');
  } catch {
    skipPatterns = [];
  }
  return {
    id: Number(row.id),
    name: row.name,
    delimiter: row.delimiter,
    encoding: row.encoding,
    headerRow: Number(row.header_row),
    dateFormat: row.date_format,
    columnMap,
    amountMode: row.amount_mode,
    skipPatterns,
    updatedAt: row.updated_at,
  };
}

export function saveProfile(db, config) {
  const v = validateProfileConfig(config);
  const res = db
    .prepare(
      `INSERT INTO profiles (name, delimiter, encoding, header_row, date_format, column_map, amount_mode, skip_patterns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      v.name,
      v.delimiter,
      v.encoding,
      v.headerRow,
      v.dateFormat,
      JSON.stringify(v.columnMap),
      v.amountMode,
      JSON.stringify(v.skipPatterns),
    );
  return Number(res.lastInsertRowid);
}

export function listProfiles(db) {
  return db
    .prepare('SELECT * FROM profiles ORDER BY id')
    .all()
    .map(hydrate);
}

export function getProfile(db, id) {
  return hydrate(db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
}

export function deleteProfile(db, id) {
  const res = db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  return Number(res.changes) > 0;
}

const PATCHABLE = ['name', 'delimiter', 'encoding', 'headerRow', 'dateFormat', 'columnMap', 'amountMode', 'skipPatterns'];

export function updateProfile(db, id, patch) {
  const existing = getProfile(db, id);
  if (!existing) return undefined;
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('updateProfile: patch must be an object');
  }
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE.includes(key)) throw new TypeError(`updateProfile: unknown patch key '${key}'`);
  }
  const { id: _omitId, updatedAt: _omitTs, ...rest } = existing;
  const merged = validateProfileConfig({ ...rest, ...patch });
  db.prepare(
    `UPDATE profiles
     SET name = ?, delimiter = ?, encoding = ?, header_row = ?, date_format = ?,
         column_map = ?, amount_mode = ?, skip_patterns = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  ).run(
    merged.name,
    merged.delimiter,
    merged.encoding,
    merged.headerRow,
    merged.dateFormat,
    JSON.stringify(merged.columnMap),
    merged.amountMode,
    JSON.stringify(merged.skipPatterns),
    id,
  );
  return getProfile(db, id);
}
