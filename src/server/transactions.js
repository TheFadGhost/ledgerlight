import { parseIsoDate } from '../core/dates.js';
import { fingerprint } from '../dedupe.js';
import { loadRules, categorizeTransaction } from '../rules/engine.js';
import { rememberMerchantCategory } from '../rules/learn.js';
import { withTransaction } from '../core/db.js';

const SORTABLE = new Map([
  ['date', 't.date'],
  ['payee', 't.payee COLLATE NOCASE'],
  ['amount', 't.amount_minor'],
  ['category', 'COALESCE(c.name, \'\') COLLATE NOCASE'],
  ['account', 'a.name COLLATE NOCASE'],
]);

export function queryTransactions(db, q = {}) {
  const where = [];
  const params = {};

  if (q.q) {
    params.like = `%${escapeLike(String(q.q))}%`;
    where.push(`(t.payee LIKE @like ESCAPE '\\' OR t.description LIKE @like ESCAPE '\\')`);
  }
  if (q.accountId) { params.accountId = Number(q.accountId); where.push('t.account_id = @accountId'); }
  const uncategorized = q.uncategorized === '1' || q.categoryId === 'none';
  if (uncategorized) {
    where.push('t.category_id IS NULL');
  } else if (q.categoryId && q.categoryId !== 'all') {
    params.categoryId = Number(q.categoryId);
    // include descendants of the chosen category
    where.push('(t.category_id = @categoryId OR c.parent_id = @categoryId)');
  }
  if (q.from) { params.from = String(q.from); where.push('t.date >= @from'); }
  if (q.to) { params.to = String(q.to); where.push('t.date <= @to'); }
  if (q.min !== undefined && q.min !== '') { params.min = Number(q.min); where.push('t.amount_minor >= @min'); }
  if (q.max !== undefined && q.max !== '') { params.max = Number(q.max); where.push('t.amount_minor <= @max'); }

  const sortCol = SORTABLE.get(q.sort || 'date') || SORTABLE.get('date');
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';

  const limit = Math.min(Math.max(Math.trunc(Number(q.limit)) || 50, 1), 500);
  const offset = Math.max(Math.trunc(Number(q.offset)) || 0, 0);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN categories p ON p.id = c.parent_id
    LEFT JOIN rules r ON r.id = t.applied_rule_id
    ${whereSql}`;

  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;
  const rows = db
    .prepare(
      `SELECT t.id, t.date, t.payee, t.description, t.amount_minor AS amountMinor,
              t.category_id AS categoryId, c.name AS categoryName, p.name AS parentCategoryName,
              t.category_source AS categorySource, t.applied_rule_id AS appliedRuleId,
              r.name AS ruleName, r.source AS ruleSource,
              t.account_id AS accountId, a.name AS accountName, t.manual,
              (SELECT COUNT(*) FROM splits s WHERE s.transaction_id = t.id) AS splitCount
       ${base}
       ORDER BY ${sortCol} ${dir}, t.id ASC
       LIMIT ${limit} OFFSET ${offset}`,
    )
    .all(params);

  return { rows, total, limit, offset };
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function getTransaction(db, id) {
  const row = db
    .prepare(
      `SELECT t.id, t.date, t.payee, t.description, t.amount_minor AS amountMinor,
              t.category_id AS categoryId, c.name AS categoryName,
              t.category_source AS categorySource, t.applied_rule_id AS appliedRuleId,
              r.name AS ruleName, r.source AS ruleSource,
              t.account_id AS accountId, a.name AS accountName, t.manual, t.fingerprint,
              t.notes
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN rules r ON r.id = t.applied_rule_id
       WHERE t.id = ?`,
    )
    .get(id);
  if (!row) return null;
  row.splits = db
    .prepare(
      `SELECT s.id, s.amount_minor AS amountMinor, s.category_id AS categoryId,
              c.name AS categoryName, s.note
       FROM splits s LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.transaction_id = ? ORDER BY s.id`,
    )
    .all(id);
  return row;
}

/**
 * Manual recategorize: source becomes 'manual' so rules never overwrite it.
 * remember=true additionally creates/updates the learned merchant rule.
 */
export function updateTransactionCategory(db, id, body) {
  const txn = db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
  if (!txn) throw err(404, 'NOT_FOUND', 'No such transaction');

  let categoryId = null;
  if (body?.categoryId != null) {
    categoryId = Number(body.categoryId);
    const cat = db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId);
    if (!cat) throw err(400, 'INVALID_CATEGORY', 'No such category');
  }

  withTransaction(db, () => {
    pushUndoInTxn(db, 'bulk_categorize', [
      { id: txn.id, categoryId: txn.category_id, source: txn.category_source, ruleId: txn.applied_rule_id },
    ]);
    applyCategory(db, txn.id, categoryId);
  });

  if (body?.remember && categoryId != null) {
    rememberMerchantCategory(db, txn.payee, categoryId);
  }
  return getTransaction(db, id);
}

function applyCategory(db, id, categoryId) {
  db.prepare(
    `UPDATE transactions SET category_id=?, applied_rule_id=NULL,
        category_source = CASE WHEN ? IS NULL THEN NULL ELSE 'manual' END
     WHERE id=?`,
  ).run(categoryId, categoryId, id);
}

export function bulkCategorize(db, body) {
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : [];
  if (ids.length === 0) throw err(400, 'NO_IDS', 'ids[] required');
  if (ids.length > 5000) throw err(400, 'TOO_MANY', 'Bulk operations capped at 5000 rows');
  let categoryId = null;
  if (body?.categoryId != null) {
    categoryId = Number(body.categoryId);
    if (!db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId)) {
      throw err(400, 'INVALID_CATEGORY', 'No such category');
    }
  }

  const placeholders = ids.map(() => '?').join(',');
  const previous = db
    .prepare(
      `SELECT id, category_id AS categoryId, category_source AS source, applied_rule_id AS ruleId
       FROM transactions WHERE id IN (${placeholders})`,
    )
    .all(...ids);
  if (previous.length === 0) return { updated: 0 };

  withTransaction(db, () => {
    pushUndoInTxn(db, 'bulk_categorize', previous);
    const upd = db.prepare(
      `UPDATE transactions SET category_id=?, applied_rule_id=NULL,
          category_source = CASE WHEN ? IS NULL THEN NULL ELSE 'manual' END
       WHERE id=?`,
    );
    for (const p of previous) upd.run(categoryId, categoryId, p.id);
  });

  if (body?.remember && categoryId != null) {
    const payees = db
      .prepare(`SELECT DISTINCT payee FROM transactions WHERE id IN (${placeholders})`)
      .all(...ids);
    for (const p of payees) rememberMerchantCategory(db, p.payee, categoryId);
  }
  return { updated: previous.length };
}

export function splitTransaction(db, id, body) {
  const txn = db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
  if (!txn) throw err(404, 'NOT_FOUND', 'No such transaction');
  const existingCount = db.prepare('SELECT COUNT(*) AS n FROM splits WHERE transaction_id=?').get(id).n;
  if (existingCount > 0) throw err(409, 'ALREADY_SPLIT', 'Transaction already has splits; unsplit first');

  const parts = Array.isArray(body?.parts) ? body.parts : [];
  if (parts.length < 2) throw err(400, 'NEED_TWO_PARTS', 'A split needs at least 2 parts');

  let sum = 0;
  const cleaned = parts.map((p, i) => {
    const amountMinor = p?.amountMinor;
    if (!Number.isInteger(amountMinor) || amountMinor === 0) {
      throw err(400, 'INVALID_PART', `parts[${i}].amountMinor must be a non-zero integer`);
    }
    sum += amountMinor;
    let categoryId = null;
    if (p?.categoryId != null) {
      categoryId = Number(p.categoryId);
      if (!db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId)) {
        throw err(400, 'INVALID_CATEGORY', `parts[${i}].categoryId does not exist`);
      }
    }
    const note = p?.note != null ? String(p.note).slice(0, 200) : '';
    return { amountMinor, categoryId, note };
  });
  if (!Number.isSafeInteger(sum)) throw err(400, 'SUM_MISMATCH', 'Split amounts overflow safe range');
  if (sum !== txn.amount_minor) {
    throw err(400, 'SUM_MISMATCH',
      `Parts sum to ${sum} minor units but transaction is ${txn.amount_minor}; difference ${txn.amount_minor - sum}. Splits must match exactly.`);
  }

  const ins = db.prepare(
    'INSERT INTO splits (transaction_id, amount_minor, category_id, note) VALUES (?, ?, ?, ?)',
  );
  const created = [];
  withTransaction(db, () => {
    for (const p of cleaned) {
      const r = ins.run(id, p.amountMinor, p.categoryId, p.note);
      created.push(r.lastInsertRowid);
    }
    pushUndoInTxn(db, 'split', { parentId: id, splitIds: created });
  });

  return getTransaction(db, id);
}

export function unsplitTransaction(db, id) {
  const txn = db.prepare('SELECT id FROM transactions WHERE id=?').get(id);
  if (!txn) throw err(404, 'NOT_FOUND', 'No such transaction');
  const rows = db.prepare('SELECT * FROM splits WHERE transaction_id=? ORDER BY id').all(id);
  if (rows.length === 0) throw err(404, 'NOT_SPLIT', 'Transaction has no splits');
  withTransaction(db, () => {
    pushUndoInTxn(db, 'unsplit', {
      rows: rows.map((r) => ({
        id: r.id, transactionId: r.transaction_id, amountMinor: r.amount_minor,
        categoryId: r.category_id, note: r.note,
      })),
    });
    db.prepare('DELETE FROM splits WHERE transaction_id=?').run(id);
  });

  return getTransaction(db, id);
}

export function createManualTransaction(db, body) {
  const accountId = Number(body?.accountId);
  const account = db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId);
  if (!account) throw err(400, 'INVALID_ACCOUNT', 'accountId must reference an existing account');
  const date = parseIsoDate(String(body?.date ?? ''));
  const payee = String(body?.payee ?? '').trim();
  if (!payee || payee.length > 120) throw err(400, 'INVALID_PAYEE', 'payee required (max 120 chars)');
  const amountMinor = body?.amountMinor;
  if (!Number.isInteger(amountMinor) || amountMinor === 0) {
    throw err(400, 'INVALID_AMOUNT', 'amountMinor must be a non-zero integer (negative expense, positive income)');
  }
  const description = body?.description != null ? String(body.description).slice(0, 300) : '';
  const notes = body?.notes != null ? String(body.notes).slice(0, 1000) : '';

  let categoryId = null;
  if (body?.categoryId != null) {
    categoryId = Number(body.categoryId);
    if (!db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId)) {
      throw err(400, 'INVALID_CATEGORY', 'categoryId does not exist');
    }
  }

  // Occurrence-qualified fingerprint keeps identical cash purchases distinct.
  const baseFp = fingerprint({ accountId, date, amountMinor, payee, description });
  const k = countOccurrences(db, accountId, baseFp);
  const fp = k === 0 ? baseFp : `${baseFp}#${k}`;

  let source = null;
  let ruleId = null;
  if (categoryId == null) {
    const verdict = categorizeTransaction(loadRules(db), {
      accountId, date, payee, description, amountMinor,
    });
    if (verdict) {
      categoryId = verdict.categoryId;
      source = verdict.source;
      ruleId = verdict.ruleId;
    }
  } else {
    source = 'manual';
  }

  const r = db
    .prepare(
      `INSERT INTO transactions
         (account_id, date, payee, description, amount_minor, category_id, category_source,
          applied_rule_id, fingerprint, notes, manual)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(accountId, date, payee, description, amountMinor, categoryId, source, ruleId, fp, notes);
  return getTransaction(db, r.lastInsertRowid);
}

function countOccurrences(db, accountId, baseFp) {
  let n = 0;
  for (const r of db
    .prepare('SELECT fingerprint FROM transactions WHERE account_id=?')
    .all(accountId)) {
    if (r.fingerprint.replace(/#\d+$/, '') === baseFp) n += 1;
  }
  return n;
}

// ---- undo log -------------------------------------------------------------

export function pushUndo(db, actionType, payload) {
  pushUndoInTxn(db, actionType, payload);
}

function pushUndoInTxn(db, actionType, payload) {
  db.prepare('INSERT INTO undo_log (action_type, payload) VALUES (?, ?)')
    .run(actionType, JSON.stringify(payload));
  db.exec(`DELETE FROM undo_log WHERE id NOT IN (SELECT id FROM undo_log ORDER BY id DESC LIMIT 20)`);
}

export function popUndo(db) {
  const row = db.prepare('SELECT * FROM undo_log ORDER BY id DESC LIMIT 1').get();
  if (!row) return { undone: null };
  const payload = JSON.parse(row.payload);

  const updTxn = db.prepare(
    'UPDATE transactions SET category_id=?, category_source=?, applied_rule_id=? WHERE id=?',
  );
  const delSplit = db.prepare('DELETE FROM splits WHERE id=? AND transaction_id=?');
  const insSplit = db.prepare(
    'INSERT INTO splits (id, transaction_id, amount_minor, category_id, note) VALUES (?, ?, ?, ?, ?)',
  );

  withTransaction(db, () => {
    if (row.action_type === 'bulk_categorize') {
      for (const p of payload) {
        updTxn.run(p.categoryId ?? null, p.source ?? null, p.ruleId ?? null, p.id);
      }
    } else if (row.action_type === 'split') {
      for (const sid of payload.splitIds) {
        delSplit.run(sid, payload.parentId);
      }
    } else if (row.action_type === 'unsplit') {
      for (const r of payload.rows) {
        insSplit.run(r.id, r.transactionId, r.amountMinor, r.categoryId, r.note);
      }
    } else {
      throw err(500, 'UNKNOWN_UNDO', `Unknown undo action ${row.action_type}`);
    }
    db.prepare('DELETE FROM undo_log WHERE id=?').run(row.id);
  });
  return { undone: row.action_type };
}

function err(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
