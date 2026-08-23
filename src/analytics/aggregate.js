import { addMonthsToKey } from '../core/dates.js';
import { ratioBasisPoints } from '../core/money.js';
import { EFF_CTE } from './effective.js';

const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertMonth(value, label) {
  if (typeof value !== 'string' || !MONTH_RE.test(value)) {
    throw new TypeError(`${label} must be a 'YYYY-MM' month key`);
  }
}

function assertDay(value, label) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) {
    throw new TypeError(`${label} must be a 'YYYY-MM-DD' date`);
  }
}

function assertLimit(limit, label) {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}

// Buckets partition a month's activity; net = income + expense + transfers +
// uncategorized reconciles every effective transaction into exactly one slot.
// expenses NEGATIVE, income POSITIVE; exclude_from_spend categories land in
// transfersMinor only; NULL-category expenses land in uncategorizedExpenseMinor.
// Split-aware via the eff CTE (see effective.js).
const BUCKETS_SQL = `
  ${EFF_CTE}
  SELECT
    COALESCE(SUM(CASE WHEN e.amountMinor > 0
                       AND COALESCE(c.exclude_from_spend, 0) = 0
                      THEN e.amountMinor ELSE 0 END), 0) AS income,
    COALESCE(SUM(CASE WHEN e.amountMinor < 0 AND c.id IS NOT NULL
                       AND c.exclude_from_spend = 0
                      THEN e.amountMinor ELSE 0 END), 0) AS expense,
    COALESCE(SUM(CASE WHEN c.exclude_from_spend = 1
                      THEN e.amountMinor ELSE 0 END), 0) AS transfers,
    COALESCE(SUM(CASE WHEN e.amountMinor < 0 AND c.id IS NULL
                      THEN e.amountMinor ELSE 0 END), 0) AS uncategorized_expense
  FROM eff e
  LEFT JOIN categories c ON c.id = e.categoryId
  WHERE substr(e.date, 1, 7) = ?
`;

export function monthSummaries(db, fromMonth, toMonth) {
  assertMonth(fromMonth, 'fromMonth');
  assertMonth(toMonth, 'toMonth');
  if (fromMonth > toMonth) throw new RangeError('fromMonth must be <= toMonth');
  const stmt = db.prepare(BUCKETS_SQL);
  const out = [];
  for (let m = fromMonth; ; m = addMonthsToKey(m, 1)) {
    const b = stmt.get(m);
    out.push({
      month: m,
      incomeMinor: b.income,
      expenseMinor: b.expense,
      netMinor: b.income + b.expense + b.transfers + b.uncategorized_expense,
      transfersMinor: b.transfers,
      uncategorizedExpenseMinor: b.uncategorized_expense,
    });
    if (m === toMonth) break;
  }
  return out;
}

export function spendByCategory(db, month, { limit = 12 } = {}) {
  assertMonth(month, 'month');
  assertLimit(limit, 'limit');
  const rows = db
    .prepare(
      `
      ${EFF_CTE}
      SELECT e.categoryId AS categoryId, c.name AS name, p.name AS parentName,
             SUM(e.amountMinor) AS total, COUNT(*) AS txnCount
      FROM eff e
      LEFT JOIN categories c ON c.id = e.categoryId
      LEFT JOIN categories p ON p.id = c.parent_id
      WHERE e.amountMinor < 0 AND COALESCE(c.exclude_from_spend, 0) = 0
        AND substr(e.date, 1, 7) = ?
      GROUP BY e.categoryId
      ORDER BY ABS(SUM(e.amountMinor)) DESC, COALESCE(c.name, 'Uncategorized') ASC
      LIMIT ?
      `,
    )
    .all(month, limit);
  return rows.map((r) => ({
    categoryId: r.categoryId ?? null,
    name: r.name ?? 'Uncategorized',
    parentName: r.parentName ?? null,
    totalMinor: r.total,
    txnCount: r.txnCount,
  }));
}

export function spendOverTime(db, fromDay, toDay) {
  assertDay(fromDay, 'fromDay');
  assertDay(toDay, 'toDay');
  return db
    .prepare(
      `
      ${EFF_CTE}
      SELECT e.date AS day, SUM(e.amountMinor) AS totalMinor
      FROM eff e
      LEFT JOIN categories c ON c.id = e.categoryId
      WHERE e.amountMinor < 0 AND COALESCE(c.exclude_from_spend, 0) = 0
        AND e.date >= ? AND e.date <= ?
      GROUP BY e.date
      ORDER BY e.date ASC
      `,
    )
    .all(fromDay, toDay)
    .map((r) => ({ day: r.day, totalMinor: r.totalMinor }));
}

export function topMerchants(db, fromDay, toDay, { limit = 8 } = {}) {
  assertDay(fromDay, 'fromDay');
  assertDay(toDay, 'toDay');
  assertLimit(limit, 'limit');
  const rows = db
    .prepare(
      `
      ${EFF_CTE}
      SELECT e.payee AS payee, COUNT(*) AS txnCount, SUM(e.amountMinor) AS total
      FROM eff e
      LEFT JOIN categories c ON c.id = e.categoryId
      WHERE e.amountMinor < 0 AND COALESCE(c.exclude_from_spend, 0) = 0
        AND e.date >= ? AND e.date <= ?
      GROUP BY e.payee
      ORDER BY ABS(SUM(e.amountMinor)) DESC, e.payee ASC
      LIMIT ?
      `,
    )
    .all(fromDay, toDay, limit);
  return rows.map((r) => ({
    payee: r.payee,
    totalMinor: -r.total,
    txnCount: r.txnCount,
  }));
}

export function momChanges(db, month) {
  assertMonth(month, 'month');
  const prevMonth = addMonthsToKey(month, -1);
  const cur = db.prepare(BUCKETS_SQL).get(month);
  const prev = db.prepare(BUCKETS_SQL).get(prevMonth);
  const net = (b) => b.income + b.expense + b.transfers + b.uncategorized_expense;
  const rows = db
    .prepare(
      `
      ${EFF_CTE}
      SELECT c.id AS categoryId, c.name AS name,
             COALESCE(SUM(CASE WHEN substr(e.date, 1, 7) = ? THEN e.amountMinor END), 0) AS currentMinor,
             COALESCE(SUM(CASE WHEN substr(e.date, 1, 7) = ? THEN e.amountMinor END), 0) AS previousMinor
      FROM eff e
      JOIN categories c ON c.id = e.categoryId
      WHERE e.amountMinor < 0 AND c.exclude_from_spend = 0
        AND substr(e.date, 1, 7) IN (?, ?)
      GROUP BY c.id
      `,
    )
    .all(month, prevMonth, month, prevMonth);
  const categories = rows
    .map((r) => {
      const deltaMinor = r.currentMinor - r.previousMinor;
      return {
        categoryId: r.categoryId,
        name: r.name,
        currentMinor: r.currentMinor,
        previousMinor: r.previousMinor,
        deltaMinor,
        deltaBps: ratioBasisPoints(deltaMinor, Math.abs(r.previousMinor)),
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.currentMinor) +
          Math.abs(b.previousMinor) -
          (Math.abs(a.currentMinor) + Math.abs(a.previousMinor)) ||
        a.name.localeCompare(b.name),
    );
  return {
    totals: {
      incomeMinor: cur.income,
      expenseMinor: cur.expense,
      netMinor: net(cur),
      prevIncomeMinor: prev.income,
      prevExpenseMinor: prev.expense,
      prevNetMinor: net(prev),
    },
    categories,
  };
}

export function uncategorizedSummary(db) {
  const row = db
    .prepare(
      `
      ${EFF_CTE}
      SELECT COUNT(*) AS count, COALESCE(SUM(e.amountMinor), 0) AS totalMinor
      FROM eff e
      WHERE e.categoryId IS NULL
      `,
    )
    .get();
  return { count: row.count, totalMinor: row.totalMinor };
}
