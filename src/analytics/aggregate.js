import { addMonthsToKey } from '../core/dates.js';
import { ratioBasisPoints } from '../core/money.js';

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
// uncategorized reconciles every transaction into exactly one visible slot.
// expenses NEGATIVE, income POSITIVE; exclude_from_spend categories land in
// transfersMinor only; NULL-category expenses land in uncategorizedExpenseMinor.
const BUCKETS_SQL = `
  SELECT
    COALESCE(SUM(CASE WHEN t.amount_minor > 0
                       AND COALESCE(c.exclude_from_spend, 0) = 0
                      THEN t.amount_minor ELSE 0 END), 0) AS income,
    COALESCE(SUM(CASE WHEN t.amount_minor < 0 AND c.id IS NOT NULL
                       AND c.exclude_from_spend = 0
                      THEN t.amount_minor ELSE 0 END), 0) AS expense,
    COALESCE(SUM(CASE WHEN c.exclude_from_spend = 1
                      THEN t.amount_minor ELSE 0 END), 0) AS transfers,
    COALESCE(SUM(CASE WHEN t.amount_minor < 0 AND c.id IS NULL
                      THEN t.amount_minor ELSE 0 END), 0) AS uncategorized_expense
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  WHERE substr(t.date, 1, 7) = ?
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
      SELECT t.category_id AS categoryId, c.name AS name, p.name AS parentName,
             SUM(t.amount_minor) AS total, COUNT(*) AS txnCount
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN categories p ON p.id = c.parent_id
      WHERE t.amount_minor < 0 AND COALESCE(c.exclude_from_spend, 0) = 0
        AND substr(t.date, 1, 7) = ?
      GROUP BY t.category_id
      ORDER BY ABS(SUM(t.amount_minor)) DESC, COALESCE(c.name, 'Uncategorized') ASC
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
      SELECT t.date AS day, SUM(t.amount_minor) AS totalMinor
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.amount_minor < 0 AND COALESCE(c.exclude_from_spend, 0) = 0
        AND t.date >= ? AND t.date <= ?
      GROUP BY t.date
      ORDER BY t.date ASC
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
      SELECT t.payee AS payee, COUNT(*) AS txnCount, SUM(t.amount_minor) AS total
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.amount_minor < 0 AND COALESCE(c.exclude_from_spend, 0) = 0
        AND t.date >= ? AND t.date <= ?
      GROUP BY t.payee
      ORDER BY ABS(SUM(t.amount_minor)) DESC, t.payee ASC
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
      SELECT c.id AS categoryId, c.name AS name,
             COALESCE(SUM(CASE WHEN substr(t.date, 1, 7) = ? THEN t.amount_minor END), 0) AS currentMinor,
             COALESCE(SUM(CASE WHEN substr(t.date, 1, 7) = ? THEN t.amount_minor END), 0) AS previousMinor
      FROM transactions t
      JOIN categories c ON c.id = t.category_id
      WHERE t.amount_minor < 0 AND c.exclude_from_spend = 0
        AND substr(t.date, 1, 7) IN (?, ?)
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
      'SELECT COUNT(*) AS count, COALESCE(SUM(amount_minor), 0) AS totalMinor FROM transactions WHERE category_id IS NULL',
    )
    .get();
  return { count: row.count, totalMinor: row.totalMinor };
}
