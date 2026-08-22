// Default category taxonomy (PLAN.md A19): ~15 leaves under 5 groups.
// Groups have kind='group'; leaves are 'expense' unless income.
// Transfers group is excluded from spend totals by default so credit-card
// payments and ATM moves do not distort category insight.

export const DEFAULT_TAXONOMY = [
  {
    name: 'Housing & Utilities', kind: 'group', children: [
      { name: 'Rent / Mortgage', kind: 'expense' },
      { name: 'Utilities & Telecom', kind: 'expense' },
      { name: 'Home Insurance', kind: 'expense' },
    ],
  },
  {
    name: 'Food & Dining', kind: 'group', children: [
      { name: 'Groceries', kind: 'expense' },
      { name: 'Restaurants & Cafes', kind: 'expense' },
    ],
  },
  {
    name: 'Transport', kind: 'group', children: [
      { name: 'Transit & Fuel', kind: 'expense' },
      { name: 'Car & Maintenance', kind: 'expense' },
    ],
  },
  {
    name: 'Personal & Health', kind: 'group', children: [
      { name: 'Health & Pharmacy', kind: 'expense' },
      { name: 'Shopping', kind: 'expense' },
      { name: 'Entertainment', kind: 'expense' },
      { name: 'Subscriptions', kind: 'expense' },
      { name: 'Travel', kind: 'expense' },
    ],
  },
  {
    name: 'Money Movement', kind: 'group', children: [
      { name: 'Salary', kind: 'income' },
      { name: 'Other Income', kind: 'income' },
      { name: 'Fees & Interest', kind: 'expense' },
      { name: 'Transfers', kind: 'expense', excludeFromSpend: true },
    ],
  },
];

// Conservative default rules: only high-precision merchant strings.
export const DEFAULT_RULES = [
  { priority: 10, name: 'Payroll deposits', matchType: 'substring', pattern: 'payroll', categoryIdName: 'Salary' },
  { priority: 11, name: 'Salary mentions', matchType: 'regex', pattern: '^salary( deposit| payment)?$', categoryIdName: 'Salary' },
];

export function seedTaxonomy(db) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (existing.n > 0) return;
  const insGroup = db.prepare(
    `INSERT INTO categories (name, parent_id, kind, exclude_from_spend, system, sort_order)
     VALUES (?, NULL, 'group', 0, 1, ?)`,
  );
  const insLeaf = db.prepare(
    `INSERT INTO categories (name, parent_id, kind, exclude_from_spend, system, sort_order)
     VALUES (?, ?, ?, ?, 1, ?)`,
  );
  let order = 0;
  const idsByName = new Map();
  for (const group of DEFAULT_TAXONOMY) {
    const g = insGroup.run(group.name, order).lastInsertRowid;
    idsByName.set(group.name, g);
    order += 1;
    let leafOrder = 0;
    for (const leaf of group.children) {
      const r = insLeaf.run(
        leaf.name, g, leaf.kind, leaf.excludeFromSpend ? 1 : 0, leafOrder,
      );
      idsByName.set(leaf.name, r.lastInsertRowid);
      leafOrder += 1;
    }
  }
  const ruleCount = db.prepare('SELECT COUNT(*) AS n FROM rules').get();
  if (ruleCount.n === 0) {
    const insRule = db.prepare(
      `INSERT INTO rules (priority, name, match_type, pattern, category_id, source, enabled)
       VALUES (?, ?, ?, ?, ?, 'user', 1)`,
    );
    for (const rule of DEFAULT_RULES) {
      const catId = idsByName.get(rule.categoryIdName);
      if (catId != null) {
        insRule.run(rule.priority, rule.name, rule.matchType, rule.pattern, catId);
      }
    }
  }
  return idsByName;
}
