import { ratioBasisPoints } from '../core/money.js';
import { EFF_CTE } from './effective.js';

const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

function assertMonth(value, label) {
  if (typeof value !== 'string' || !MONTH_RE.test(value)) {
    throw new TypeError(`${label} must be a 'YYYY-MM' month key`);
  }
}

export function setBudget(db, categoryId, monthlyAmountMinor) {
  if (!Number.isInteger(monthlyAmountMinor) || monthlyAmountMinor <= 0) {
    throw new TypeError('monthlyAmountMinor must be an integer > 0');
  }
  db.prepare(
    `
    INSERT INTO budgets (category_id, monthly_amount_minor)
    VALUES (?, ?)
    ON CONFLICT(category_id) DO UPDATE SET monthly_amount_minor = excluded.monthly_amount_minor
    `,
  ).run(categoryId, monthlyAmountMinor);
  const row = db.prepare('SELECT id FROM budgets WHERE category_id = ?').get(categoryId);
  return row.id;
}

export function deleteBudget(db, categoryId) {
  const r = db.prepare('DELETE FROM budgets WHERE category_id = ?').run(Number(categoryId));
  if (r.changes === 0) {
    const e = new Error('No budget for that category');
    e.code = 'NOT_FOUND';
    e.status = 404;
    throw e;
  }
}

export function budgetStatus(db, month) {
  assertMonth(month, 'month');
  const rows = db
    .prepare(
      `
      ${EFF_CTE}
      SELECT b.id AS budgetId, b.category_id AS categoryId,
             c.name AS categoryName, p.name AS parentName,
             b.monthly_amount_minor AS monthlyAmountMinor,
             COALESCE((
               SELECT SUM(e.amountMinor) FROM eff e
               WHERE e.categoryId = b.category_id AND e.amountMinor < 0
                 AND substr(e.date, 1, 7) = ?
             ), 0) AS spentMinor
      FROM budgets b
      JOIN categories c ON c.id = b.category_id
      LEFT JOIN categories p ON p.id = c.parent_id
      `,
    )
    .all(month);
  const out = rows.map((r) => {
    const pctUsedBps = ratioBasisPoints(Math.abs(r.spentMinor), r.monthlyAmountMinor);
    let state;
    if (pctUsedBps > 10000) state = 'over';
    else if (pctUsedBps >= 8000) state = 'near';
    else state = 'under';
    return {
      budgetId: r.budgetId,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      parentName: r.parentName ?? null,
      monthlyAmountMinor: r.monthlyAmountMinor,
      spentMinor: r.spentMinor,
      remainingMinor: r.monthlyAmountMinor + r.spentMinor,
      pctUsedBps,
      state,
    };
  });
  out.sort(
    (a, b) =>
      b.pctUsedBps - a.pctUsedBps ||
      a.categoryName.localeCompare(b.categoryName),
  );
  return out;
}

export function uncategorizedInMonth(db, month) {
  assertMonth(month, 'month');
  const row = db
    .prepare(
      `
      ${EFF_CTE}
      SELECT COUNT(*) AS count, COALESCE(SUM(e.amountMinor), 0) AS totalMinor
      FROM eff e
      WHERE e.categoryId IS NULL AND substr(e.date, 1, 7) = ?
      `,
    )
    .get(month);
  return { count: row.count, totalMinor: row.totalMinor };
}
