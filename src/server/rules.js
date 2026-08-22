import { validateRule, testRule } from '../rules/engine.js';

export function testRuleDraft(db, body) {
  return testRule(db, body);
}

export function listRulesWithCategories(db) {
  return db
    .prepare(
      `SELECT r.id, r.priority, r.name, r.match_type AS matchType, r.pattern,
              r.min_amount_minor AS minAmountMinor, r.max_amount_minor AS maxAmountMinor,
              r.account_id AS accountId, a.name AS accountName,
              r.category_id AS categoryId, c.name AS categoryName, p.name AS parentCategoryName,
              r.source, r.enabled
       FROM rules r
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN categories c ON c.id = r.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
       ORDER BY CASE WHEN r.source='learned' THEN 0 ELSE 1 END, r.priority, r.id`,
    )
    .all();
}

export function createRule(db, body) {
  const rule = validateRule(body);
  const name = rule.name || defaultName(rule);
  const priority = Number.isInteger(body?.priority) ? body.priority : 100;
  const r = db
    .prepare(
      `INSERT INTO rules (priority, name, match_type, pattern, min_amount_minor, max_amount_minor,
                          account_id, category_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user')`,
    )
    .run(priority, name, rule.matchType, rule.pattern ?? null, rule.minAmountMinor ?? null,
      rule.maxAmountMinor ?? null, body?.accountId != null ? Number(body.accountId) : null,
      rule.categoryId);
  return db.prepare('SELECT * FROM rules WHERE id=?').get(r.lastInsertRowid);
}

export function updateRule(db, id, body) {
  const existing = db.prepare('SELECT * FROM rules WHERE id=?').get(id);
  if (!existing) throw err(404, 'NOT_FOUND', 'No such rule');
  if (existing.source === 'learned' && body && Object.keys(body).some((k) => k !== 'enabled')) {
    throw err(400, 'LEARNED_IMMUTABLE', 'Learned rules can only be enabled/disabled or deleted');
  }
  const merged = {
    matchType: body.matchType ?? existing.match_type,
    pattern: body.pattern !== undefined ? body.pattern : existing.pattern,
    minAmountMinor: body.minAmountMinor !== undefined ? body.minAmountMinor : existing.min_amount_minor,
    maxAmountMinor: body.maxAmountMinor !== undefined ? body.maxAmountMinor : existing.max_amount_minor,
    categoryId: body.categoryId !== undefined ? Number(body.categoryId) : existing.category_id,
    accountId: body.accountId !== undefined ? (body.accountId == null ? null : Number(body.accountId)) : existing.account_id,
    name: body.name !== undefined ? body.name : existing.name,
  };
  const rule = validateRule(merged);
  const priority = Number.isInteger(body?.priority) ? body.priority : existing.priority;
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
  db.prepare(
    `UPDATE rules SET priority=?, name=?, match_type=?, pattern=?, min_amount_minor=?,
                       max_amount_minor=?, account_id=?, category_id=?, enabled=? WHERE id=?`,
  ).run(priority, rule.name || existing.name, rule.matchType, rule.pattern ?? null,
    rule.minAmountMinor ?? null, rule.maxAmountMinor ?? null, merged.accountId,
    rule.categoryId, enabled, id);
  return db.prepare('SELECT * FROM rules WHERE id=?').get(id);
}

export function deleteRule(db, id) {
  const r = db.prepare('DELETE FROM rules WHERE id=?').run(id);
  if (r.changes === 0) throw err(404, 'NOT_FOUND', 'No such rule');
}

function defaultName(rule) {
  if (rule.matchType === 'amount_range') {
    return `Amount ${rule.minAmountMinor ?? '…'} to ${rule.maxAmountMinor ?? '…'}`;
  }
  const p = String(rule.pattern ?? '');
  return p.length > 24 ? `${p.slice(0, 24)}…` : p;
}

function err(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
