import { normalizePayee } from '../dedupe.js';

export function rememberMerchantCategory(db, payee, categoryId) {
  if (!Number.isInteger(categoryId)) {
    throw new TypeError(`categoryId must be an integer, got ${JSON.stringify(categoryId)}`);
  }
  const normalized = normalizePayee(payee ?? '', '');
  if (!normalized) {
    throw new TypeError(`payee ${JSON.stringify(payee)} normalizes to an empty string`);
  }
  const existing = db
    .prepare(
      `SELECT id FROM rules WHERE source = 'learned' AND match_type = 'substring' AND pattern = ?`,
    )
    .get(normalized);
  if (existing) {
    db.prepare(
      `UPDATE rules SET category_id = ?, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    ).run(categoryId, existing.id);
    return { ruleId: existing.id, updated: true };
  }
  const res = db
    .prepare(
      `INSERT INTO rules (priority, name, match_type, pattern, category_id, source, enabled)
       VALUES (0, ?, 'substring', ?, ?, 'learned', 1)`,
    )
    .run(`Learned: ${payee}`, normalized, categoryId);
  return { ruleId: Number(res.lastInsertRowid), updated: false };
}

export function forgetMerchantCategory(db, ruleId) {
  const res = db.prepare(`DELETE FROM rules WHERE id = ? AND source = 'learned'`).run(ruleId);
  return res.changes > 0;
}
