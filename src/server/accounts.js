const ACCOUNT_TYPES = new Set(['checking', 'savings', 'credit', 'cash']);

export function listAccounts(db) {
  return db.prepare('SELECT * FROM accounts ORDER BY name').all();
}

export function accountBalances(db) {
  const accounts = listAccounts(db);
  const sums = db
    .prepare(`SELECT account_id, SUM(amount_minor) AS s FROM transactions GROUP BY account_id`)
    .all();
  const byId = new Map(sums.map((r) => [r.account_id, r.s]));
  return accounts.map((a) => ({
    ...a,
    balanceMinor: a.opening_balance_minor + (byId.get(a.id) ?? 0),
    txnCount: db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id=?').get(a.id).n,
  }));
}

export function createAccount(db, body) {
  const name = String(body?.name ?? '').trim();
  if (!name || name.length > 80) throw err(400, 'INVALID_NAME', 'Account name required (max 80 chars)');
  const type = body?.type ?? 'checking';
  if (!ACCOUNT_TYPES.has(type)) throw err(400, 'INVALID_TYPE', `type must be one of ${[...ACCOUNT_TYPES].join(', ')}`);
  const currency = String(body?.currency ?? 'USD').trim().toUpperCase() || 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) throw err(400, 'INVALID_CURRENCY', 'currency must be a 3-letter code');
  const opening = body?.openingBalanceMinor ?? 0;
  if (!Number.isInteger(opening)) throw err(400, 'INVALID_AMOUNT', 'openingBalanceMinor must be an integer (minor units)');
  try {
    const r = db
      .prepare('INSERT INTO accounts (name, type, currency, opening_balance_minor) VALUES (?, ?, ?, ?)')
      .run(name, type, currency, opening);
    return db.prepare('SELECT * FROM accounts WHERE id=?').get(r.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw err(409, 'DUPLICATE_NAME', `An account named ${JSON.stringify(name)} already exists`);
    throw e;
  }
}

export function updateAccount(db, id, body) {
  const existing = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (!existing) throw err(404, 'NOT_FOUND', 'No such account');
  const name = body.name !== undefined ? String(body.name).trim() : existing.name;
  if (!name || name.length > 80) throw err(400, 'INVALID_NAME', 'Account name required (max 80 chars)');
  const type = body.type !== undefined ? body.type : existing.type;
  if (!ACCOUNT_TYPES.has(type)) throw err(400, 'INVALID_TYPE', 'bad type');
  const opening = body.openingBalanceMinor !== undefined ? body.openingBalanceMinor : existing.opening_balance_minor;
  if (!Number.isInteger(opening)) throw err(400, 'INVALID_AMOUNT', 'openingBalanceMinor must be an integer');
  db.prepare('UPDATE accounts SET name=?, type=?, opening_balance_minor=? WHERE id=?')
    .run(name, type, opening, id);
  return db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
}

export function deleteAccount(db, id) {
  const r = db.prepare('DELETE FROM accounts WHERE id=?').run(id);
  if (r.changes === 0) throw err(404, 'NOT_FOUND', 'No such account');
}

function err(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
