import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import {
  RuleValidationError,
  validateRule,
  compileRule,
  loadRules,
  matches,
  categorizeTransaction,
  applyRulesToUnprocessed,
  testRule,
  compileRules,
} from '../src/rules/engine.js';
import { rememberMerchantCategory, forgetMerchantCategory } from '../src/rules/learn.js';

let fpSeq = 0;

function setup() {
  const db = openDb(':memory:');
  const cats = seedTaxonomy(db);
  const a1 = Number(
    db.prepare(`INSERT INTO accounts (name) VALUES ('Main')`).run().lastInsertRowid,
  );
  const a2 = Number(
    db.prepare(`INSERT INTO accounts (name) VALUES ('Other')`).run().lastInsertRowid,
  );
  return { db, cats, a1, a2 };
}

const cat = (cats, name) => {
  const id = cats.get(name);
  if (id == null) throw new Error(`missing category ${name}`);
  return id;
};

function insRule(db, r) {
  const res = db
    .prepare(
      `INSERT INTO rules (priority, name, match_type, pattern, min_amount_minor, max_amount_minor,
                          account_id, category_id, source, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.priority ?? 100,
      r.name ?? 'rule',
      r.match_type,
      r.pattern ?? null,
      r.min_amount_minor ?? null,
      r.max_amount_minor ?? null,
      r.account_id ?? null,
      r.category_id,
      r.source ?? 'user',
      r.enabled === false ? 0 : 1,
    );
  return Number(res.lastInsertRowid);
}

function mkTxn(db, accountId, { date, payee, description = '', amountMinor }) {
  fpSeq += 1;
  const res = db
    .prepare(
      `INSERT INTO transactions (account_id, date, payee, description, amount_minor, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(accountId, date, payee, description, amountMinor, `fp-${fpSeq}`);
  return Number(res.lastInsertRowid);
}

test('validateRule accepts valid drafts and normalizes fields', () => {
  const n = validateRule({
    matchType: 'substring',
    pattern: 'kroger',
    categoryId: 7,
    name: 'Kroger rule',
  });
  assert.deepEqual(n, {
    matchType: 'substring',
    pattern: 'kroger',
    minAmountMinor: null,
    maxAmountMinor: null,
    categoryId: 7,
    accountId: null,
    name: 'Kroger rule',
  });

  const ar = validateRule({ matchType: 'amount_range', minAmountMinor: -5000, categoryId: 3 });
  assert.equal(ar.minAmountMinor, -5000);
  assert.equal(ar.maxAmountMinor, null);
  assert.equal(ar.pattern, null);

  assert.equal(validateRule({ matchType: 'any', categoryId: 1 }).pattern, null);

  const re = validateRule({ matchType: 'regex', pattern: '^netflix', categoryId: 2 });
  assert.equal(re.pattern, '^netflix');
});

test('validateRule rejects unknown matchType, bad patterns, bad ranges, bad category', () => {
  assert.throws(() => validateRule({ matchType: 'fuzzy', pattern: 'x', categoryId: 1 }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'substring', pattern: '', categoryId: 1 }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'substring', pattern: 'x'.repeat(201), categoryId: 1 }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'regex', pattern: '(' , categoryId: 1 }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'regex', pattern: '[unclosed', categoryId: 1 }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'regex', pattern: 'x'.repeat(201), categoryId: 1 }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'amount_range', categoryId: 1 }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'amount_range', minAmountMinor: 10, maxAmountMinor: 5, categoryId: 1 }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'amount_range', minAmountMinor: 1.5, categoryId: 1 }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'amount_range', maxAmountMinor: 'big', categoryId: 1 }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'substring', pattern: 'ok' }), RuleValidationError);
  assert.throws(() => validateRule({ matchType: 'substring', pattern: 'ok', categoryId: 'nope' }), RuleValidationError);
});

test('compileRule attaches RegExp only for regex rules; compileRules is loadRules alias', () => {
  const sub = compileRule({ id: 1, match_type: 'substring', pattern: 'a', category_id: 1 });
  assert.equal(sub.compiled, null);
  const any = compileRule({ id: 2, match_type: 'any', pattern: null, category_id: 1 });
  assert.equal(any.compiled, null);
  const re = compileRule({ id: 3, match_type: 'regex', pattern: '^ab+c$', category_id: 1 });
  assert.ok(re.compiled instanceof RegExp);
  assert.equal(re.compiled.source, '^ab+c$');
  assert.equal(compileRules, loadRules);
});

test('loadRules orders learned (newest first) before user (priority ASC, id ASC); skips disabled and broken', () => {
  const { db, cats } = setup();
  const groceries = cat(cats, 'Groceries');
  const salary = cat(cats, 'Salary');
  const dining = cat(cats, 'Restaurants & Cafes');

  insRule(db, { priority: 50, match_type: 'substring', pattern: 'midprio', category_id: groceries });
  insRule(db, { priority: 5, match_type: 'substring', pattern: 'topprio', category_id: groceries });
  insRule(db, { priority: 50, match_type: 'substring', pattern: 'midprio2', category_id: groceries }); // tie -> higher id later
  insRule(db, { match_type: 'regex', pattern: '(broken', category_id: groceries }); // uncompilable -> skipped
  insRule(db, { priority: 1, match_type: 'substring', pattern: 'disabled', category_id: groceries, enabled: false });

  rememberMerchantCategory(db, 'blue bottle coffee', dining);
  rememberMerchantCategory(db, 'joes diner', dining);
  const learnNewestPattern = 'joes diner';

  const rules = loadRules(db);
  const names = rules.map((r) => r.pattern);
  // learned block first, newest created_at first (tie broken by id DESC)
  assert.deepEqual(names.slice(0, 2), [learnNewestPattern, 'blue bottle coffee']);
  assert.equal(rules.filter((r) => r.source === 'learned').length, 2);
  // then user by priority asc (includes the two seeded defaults at priority 10/11)
  assert.deepEqual(names.slice(2), [
    'topprio',
    'payroll',
    '^salary( deposit| payment)?$',
    'midprio',
    'midprio2',
  ]);
  // broken regex and disabled rule never appear
  assert.equal(rules.some((r) => r.pattern === 'disabled'), false);
  assert.equal(rules.some((r) => r.pattern === '(broken'), false);
  // every returned regex row has a live compiled RegExp
  for (const r of rules) {
    if ((r.match_type ?? r.matchType) === 'regex') assert.ok(r.compiled instanceof RegExp);
  }
});

test('matches: substring is case-insensitive across payee+description', () => {
  const rule = { match_type: 'substring', pattern: 'kroger', compiled: null };
  assert.equal(matches(rule, { payee: 'KROGER #4444', description: '' }), true);
  assert.equal(matches(rule, { payee: 'fuel', description: 'KrOgEr fill-up' }), true);
  assert.equal(matches(rule, { payee: 'publix', description: 'groceries' }), false);
  assert.equal(matches(rule, { payee: undefined, description: undefined }), false);
});

test('matches: regex correctness including anchors on combined text', () => {
  const anchored = compileRule({
    id: 1,
    match_type: 'regex',
    pattern: '^streamflix( premium)?( app)?$',
    category_id: 1,
  });
  assert.equal(matches(anchored, { payee: 'streamflix premium', description: '' }), true);
  assert.equal(matches(anchored, { payee: 'STREAMFLIX APP', description: '' }), false); // regex is case-sensitive
  assert.equal(matches(anchored, { payee: 'Notstreamflix premium', description: '' }), false);
  assert.equal(
    matches(anchored, { payee: 'streamflix premium', description: 'monthly plan' }),
    false,
    'end anchor fails once a description joins the haystack',
  );

  const joinProvesCombination = compileRule({
    id: 4,
    match_type: 'regex',
    pattern: '^Payroll Co year',
    category_id: 1,
  });
  assert.equal(matches(joinProvesCombination, { payee: 'Payroll Co', description: 'yearly bonus' }), true);
  assert.equal(matches(joinProvesCombination, { payee: 'Payroll Co', description: '' }), false);

  const endAnchor = compileRule({
    id: 2,
    match_type: 'regex',
    pattern: 'bonus\\s*$',
    category_id: 1,
  });
  assert.equal(matches(endAnchor, { payee: 'Payroll Co', description: 'year bonus' }), true);
  assert.equal(matches(endAnchor, { payee: 'Payroll Co', description: 'bonus year' }), false);

  const startAnchor = compileRule({ id: 3, match_type: 'regex', pattern: '^payroll', category_id: 1 });
  assert.equal(matches(startAnchor, { payee: 'co payroll dept', description: '' }), false);
  assert.equal(matches(startAnchor, { payee: 'payroll Dept', description: '' }), true);
});

test('matches: >500-char payee does not crash and still matches prefix-anchored patterns', () => {
  const longPayee = `MegaCorp ${'x'.repeat(600)}`;
  const prefixRule = compileRule({ id: 1, match_type: 'regex', pattern: '^MegaCorp\\b', category_id: 1 });
  assert.equal(matches(prefixRule, { payee: longPayee, description: '' }), true);

  const tailNeedle = compileRule({ id: 2, match_type: 'regex', pattern: 'tailmarker$', category_id: 1 });
  assert.equal(
    matches(tailNeedle, { payee: `MegaCorp ${'y'.repeat(600)} tailmarker`, description: '' }),
    false,
    'text beyond the 500-char truncation window is not tested',
  );
  assert.equal(
    matches(tailNeedle, { payee: `${'y'.repeat(400)} tailmarker`, description: '' }),
    true,
  );

  const sub = { match_type: 'substring', pattern: 'needle'.concat('z'.repeat(300)), compiled: null };
  assert.doesNotThrow(() => matches(sub, { payee: longPayee, description: longPayee }));
  assert.equal(matches(sub, { payee: longPayee, description: '' }), false);
});

test('matches: amount_range bounds are inclusive at min and max', () => {
  const rule = { match_type: 'amount_range', min_amount_minor: -5000, max_amount_minor: -1000 };
  assert.equal(matches(rule, { amountMinor: -5000 }), true, 'min == amount matches');
  assert.equal(matches(rule, { amountMinor: -1000 }), true, 'max == amount matches');
  assert.equal(matches(rule, { amountMinor: -2500 }), true);
  assert.equal(matches(rule, { amountMinor: -5001 }), false);
  assert.equal(matches(rule, { amountMinor: -999 }), false);

  const minOnly = { match_type: 'amount_range', min_amount_minor: 100 };
  assert.equal(matches(minOnly, { amountMinor: 100 }), true);
  assert.equal(matches(minOnly, { amountMinor: 99 }), false);
  const maxOnly = { match_type: 'amount_range', max_amount_minor: 100 };
  assert.equal(matches(maxOnly, { amountMinor: 100 }), true);
  assert.equal(matches(maxOnly, { amountMinor: 101 }), false);
});

test('matches: account_id filter scopes every rule type; unscoped rules match any account', () => {
  const scopedAny = { match_type: 'any', account_id: 42 };
  assert.equal(matches(scopedAny, { accountId: 42 }), true);
  assert.equal(matches(scopedAny, { accountId: 43 }), false);
  assert.equal(matches(scopedAny, {}), false, 'unknown account never satisfies an account-scoped rule');
  const scopedSub = { match_type: 'substring', pattern: 'kroger', account_id: 42 };
  assert.equal(matches(scopedSub, { accountId: 42, payee: 'Kroger' }), true);
  assert.equal(matches(scopedSub, { accountId: 43, payee: 'Kroger' }), false);
  const unscoped = { match_type: 'any' };
  assert.equal(matches(unscoped, { accountId: 999 }), true);
});

test('categorizeTransaction: first match wins preserving order; reports learned vs rule source', () => {
  const rules = [
    { id: 11, match_type: 'any', category_id: 111, source: 'user' },
    { id: 12, match_type: 'substring', pattern: 'kroger', category_id: 222, source: 'learned' },
  ];
  assert.deepEqual(categorizeTransaction(rules, { payee: 'KROGER', accountId: 1 }), {
    categoryId: 111,
    source: 'rule',
    ruleId: 11,
  });
  assert.deepEqual(categorizeTransaction([rules[1]], { payee: 'kroger' }), {
    categoryId: 222,
    source: 'learned',
    ruleId: 12,
  });
  assert.deepEqual(categorizeTransaction([], { payee: 'anything' }), {
    categoryId: null,
    source: null,
    ruleId: null,
  });
});

test('learned rules beat user rules regardless of priority number', () => {
  const { db, cats } = setup();
  const groceries = cat(cats, 'Groceries');
  const dining = cat(cats, 'Restaurants & Cafes');
  insRule(db, { priority: -1000, match_type: 'substring', pattern: 'blue bottle', category_id: groceries });
  const learned = rememberMerchantCategory(db, 'Blue Bottle Coffee', dining);

  const txn = { accountId: 1, payee: 'BLUE BOTTLE COFFEE', description: '', amountMinor: -450 };
  const res = categorizeTransaction(loadRules(db), txn);
  assert.equal(res.categoryId, dining);
  assert.equal(res.source, 'learned');
  assert.equal(res.ruleId, learned.ruleId);
});

test('applyRulesToUnprocessed categorizes only untouched non-manual txns and counts new ones', () => {
  const { db, cats, a1 } = setup();
  const groceries = cat(cats, 'Groceries');
  const fuel = cat(cats, 'Transit & Fuel');
  insRule(db, { priority: 10, match_type: 'substring', pattern: 'kroger', category_id: groceries });
  insRule(db, { priority: 20, match_type: 'regex', pattern: '^Shell', category_id: fuel });

  mkTxn(db, a1, { date: '2026-01-02', payee: 'KROGER #1234', amountMinor: -5400 });
  mkTxn(db, a1, { date: '2026-01-03', payee: 'Shell Oil', amountMinor: -3200 });
  mkTxn(db, a1, { date: '2026-01-04', payee: 'Unmatched Bistro', amountMinor: -8000 });
  fpSeq += 1;
  db.prepare(
    `INSERT INTO transactions (account_id, date, payee, amount_minor, manual, fingerprint)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(a1, '2026-01-05', 'Manual Kroger entry', -9000, `fp-${fpSeq}`);
  fpSeq += 1;
  db.prepare(
    `INSERT INTO transactions (account_id, date, payee, amount_minor, category_id, category_source, fingerprint)
     VALUES (?, ?, ?, ?, ?, 'imported', ?)`,
  ).run(a1, '2026-01-06', 'Imported Kroger', -1000, groceries, `fp-${fpSeq}`);

  const first = applyRulesToUnprocessed(db);
  assert.equal(first.categorized, 2, 'only the two clean uncategorized txns are categorized');

  const rows = db.prepare('SELECT payee, category_id, category_source, applied_rule_id FROM transactions ORDER BY id').all();
  const kroger = rows.find((r) => r.payee === 'KROGER #1234');
  assert.equal(kroger.category_id, groceries);
  assert.equal(kroger.category_source, 'rule');
  assert.ok(kroger.applied_rule_id != null);
  const shell = rows.find((r) => r.payee === 'Shell Oil');
  assert.equal(shell.category_source, 'rule');
  assert.ok(shell.applied_rule_id != null);
  const unmatched = rows.find((r) => r.payee === 'Unmatched Bistro');
  assert.equal(unmatched.category_id, null);
  assert.equal(unmatched.category_source, null);
  assert.equal(unmatched.applied_rule_id, null);
  const manual = rows.find((r) => r.payee === 'Manual Kroger entry');
  assert.equal(manual.category_id, null, 'manual txns are never touched');
  assert.equal(manual.category_source, null);
  const imported = rows.find((r) => r.payee === 'Imported Kroger');
  assert.equal(imported.category_source, 'imported', 'source-set txns are never overridden');

  const second = applyRulesToUnprocessed(db);
  assert.equal(second.categorized, 0, 'second run finds nothing new to do');
});

test('testRule validates the draft and returns exact count with samples <= limit ordered date DESC', () => {
  const { db, cats, a1 } = setup();
  const groceries = cat(cats, 'Groceries');
  insRule(db, { priority: 10, match_type: 'substring', pattern: 'kroger', category_id: groceries });

  mkTxn(db, a1, { date: '2026-03-01', payee: 'Kroger A', amountMinor: -100 });
  mkTxn(db, a1, { date: '2026-01-01', payee: 'Kroger B', amountMinor: -200 });
  mkTxn(db, a1, { date: '2026-02-01', payee: 'KROGER C', amountMinor: -300 });
  mkTxn(db, a1, { date: '2026-04-01', payee: 'Publix', amountMinor: -400 });
  mkTxn(db, a1, { date: '2026-05-01', payee: 'Target', amountMinor: -500 });
  mkTxn(db, a1, { date: '2026-06-01', payee: 'Kroger D', amountMinor: -600 });

  const res = testRule(db, { matchType: 'substring', pattern: 'kroger', categoryId: groceries }, 2);
  assert.equal(res.matchedCount, 4, 'count covers ALL matching txns regardless of limit');
  assert.equal(res.samples.length, 2);
  assert.deepEqual(res.samples.map((s) => s.date), ['2026-06-01', '2026-03-01'], 'date DESC');
  for (const s of res.samples) {
    assert.deepEqual(Object.keys(s).sort(), ['amountMinor', 'date', 'id', 'payee']);
    assert.ok(Number.isInteger(s.id));
    assert.ok(Number.isInteger(s.amountMinor));
  }

  const big = testRule(db, { matchType: 'substring', pattern: 'kroger', categoryId: groceries }, 50);
  assert.equal(big.matchedCount, 4);
  assert.equal(big.samples.length, 4);

  const range = testRule(
    db,
    { matchType: 'amount_range', minAmountMinor: -500, maxAmountMinor: -100, categoryId: groceries },
    10,
  );
  assert.equal(range.matchedCount, 5, 'all amounts inside the inclusive range [-500, -100] (−600 is below min)');
  assert.equal(range.samples.length, 5);

  assert.throws(
    () => testRule(db, { matchType: 'substring', pattern: '', categoryId: groceries }),
    RuleValidationError,
  );
});

test('rememberMerchantCategory upserts on exact normalized merchant (update, not duplicate)', () => {
  const { db, cats } = setup();
  const groceries = cat(cats, 'Groceries');
  const shopping = cat(cats, 'Shopping');

  const first = rememberMerchantCategory(db, 'Whole Foods Market', groceries);
  assert.equal(typeof first.ruleId, 'number');
  assert.equal(first.updated, false);

  let learned = db.prepare(`SELECT * FROM rules WHERE source = 'learned'`).all();
  assert.equal(learned.length, 1);
  assert.equal(learned[0].priority, 0);
  assert.equal(learned[0].name, 'Learned: Whole Foods Market');
  assert.equal(learned[0].match_type, 'substring');
  assert.equal(learned[0].pattern, 'whole foods market');
  assert.equal(learned[0].category_id, groceries);

  const second = rememberMerchantCategory(db, 'Whole Foods Market', shopping);
  assert.equal(second.ruleId, first.ruleId, 'same normalized merchant updates the same rule');
  assert.equal(second.updated, true);
  learned = db.prepare(`SELECT * FROM rules WHERE source = 'learned'`).all();
  assert.equal(learned.length, 1, 'no duplicate row created');
  assert.equal(learned[0].category_id, shopping);

  const third = rememberMerchantCategory(db, 'CARD PURCHASE Whole Foods Market', groceries);
  assert.equal(third.ruleId, first.ruleId, 'noise-prefix normalization hits the same key');
  assert.equal(third.updated, true);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM rules WHERE source='learned'`).get().n, 1);

  const evaluated = categorizeTransaction(loadRules(db), {
    accountId: 1,
    payee: 'WHOLE FOODS MARKET #101',
  });
  assert.equal(evaluated.categoryId, groceries);
  assert.equal(evaluated.source, 'learned');
  assert.equal(evaluated.ruleId, first.ruleId);
});

test('forgetMerchantCategory deletes only learned rules', () => {
  const { db, cats } = setup();
  const groceries = cat(cats, 'Groceries');
  insRule(db, { priority: 10, match_type: 'substring', pattern: 'kroger', category_id: groceries });
  const userRuleId = db.prepare("SELECT id FROM rules WHERE pattern='kroger'").get().id;
  const learnedId = rememberMerchantCategory(db, 'Joes Diner', groceries).ruleId;

  assert.equal(forgetMerchantCategory(db, userRuleId), false, 'refuses user rules');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rules').get().n, 4, '2 seeded + kroger + learned');

  assert.equal(forgetMerchantCategory(db, learnedId), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rules').get().n, 3);
  assert.equal(forgetMerchantCategory(db, learnedId), false, 'already gone');
});
