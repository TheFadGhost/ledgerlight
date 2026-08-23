// Shared "effective transactions" CTE: the single source of truth for how
// aggregations treat split transactions.
//
// A transaction WITH splits contributes nothing itself; its split children
// contribute their own amounts/categories under the parent's date, payee and
// account. This guarantees no double counting and lets split parts land in
// the right category budgets/charts. Money stays integer minor units.

export const EFF_CTE = `
  WITH eff AS (
    SELECT t.id AS txnId,
           t.date AS date,
           t.payee AS payee,
           t.account_id AS accountId,
           t.category_id AS categoryId,
           t.amount_minor AS amountMinor
    FROM transactions t
    WHERE NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)
    UNION ALL
    SELECT s.transaction_id AS txnId,
           p.date AS date,
           p.payee AS payee,
           p.account_id AS accountId,
           s.category_id AS categoryId,
           s.amount_minor AS amountMinor
    FROM splits s
    JOIN transactions p ON p.id = s.transaction_id
  )
`;
