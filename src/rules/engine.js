const PATTERN_MAX = 200;
const MATCH_INPUT_MAX = 500;
const REGEX_PROBE = 'the quick brown fox jumps over 123 lazy dogs';
const MATCH_TYPES = ['substring', 'regex', 'amount_range', 'any'];

export class RuleValidationError extends Error {
  constructor(message, meta) {
    super(message);
    this.name = 'RuleValidationError';
    if (meta !== undefined) this.meta = meta;
  }
}

function combinedText(txn) {
  const parts = [];
  if (txn.payee != null && txn.payee !== '') parts.push(String(txn.payee));
  if (txn.description != null && txn.description !== '') parts.push(String(txn.description));
  return parts.join(' ');
}

export function validateRule({
  matchType,
  pattern,
  minAmountMinor,
  maxAmountMinor,
  categoryId,
  accountId = null,
  name,
} = {}) {
  if (!MATCH_TYPES.includes(matchType)) {
    throw new RuleValidationError(
      `unknown matchType ${JSON.stringify(matchType)}; expected one of ${JSON.stringify(MATCH_TYPES)}`,
      { matchType },
    );
  }

  let normPattern = null;
  if (matchType === 'substring' || matchType === 'regex') {
    const p = typeof pattern === 'string' ? pattern : String(pattern ?? '');
    if (p.length === 0) {
      throw new RuleValidationError(`${matchType} pattern must not be empty`, { pattern });
    }
    if (p.length > PATTERN_MAX) {
      throw new RuleValidationError(
        `${matchType} pattern exceeds ${PATTERN_MAX} characters (got ${p.length})`,
        { patternLength: p.length },
      );
    }
    normPattern = p;
    if (matchType === 'regex') {
      let re;
      try {
        re = new RegExp(p);
      } catch (err) {
        throw new RuleValidationError(`invalid regex pattern: ${err.message}`, { pattern: p });
      }
      try {
        re.test(REGEX_PROBE);
      } catch (err) {
        throw new RuleValidationError(`regex pattern throws on execution: ${err.message}`, {
          pattern: p,
        });
      }
    }
  }

  let normMin = null;
  let normMax = null;
  if (matchType === 'amount_range') {
    const hasMin = minAmountMinor != null;
    const hasMax = maxAmountMinor != null;
    if (!hasMin && !hasMax) {
      throw new RuleValidationError(
        'amount_range requires at least one of minAmountMinor/maxAmountMinor',
      );
    }
    if (hasMin && !Number.isInteger(minAmountMinor)) {
      throw new RuleValidationError(
        `minAmountMinor must be an integer minor-unit amount, got ${JSON.stringify(minAmountMinor)}`,
      );
    }
    if (hasMax && !Number.isInteger(maxAmountMinor)) {
      throw new RuleValidationError(
        `maxAmountMinor must be an integer minor-unit amount, got ${JSON.stringify(maxAmountMinor)}`,
      );
    }
    if (hasMin && hasMax && minAmountMinor > maxAmountMinor) {
      throw new RuleValidationError(
        `minAmountMinor (${minAmountMinor}) must be <= maxAmountMinor (${maxAmountMinor})`,
      );
    }
    normMin = hasMin ? minAmountMinor : null;
    normMax = hasMax ? maxAmountMinor : null;
  }

  if (!Number.isInteger(categoryId)) {
    throw new RuleValidationError(
      `categoryId is required and must be an integer, got ${JSON.stringify(categoryId)}`,
      { categoryId },
    );
  }

  let normAccount = null;
  if (accountId != null) {
    if (!Number.isInteger(accountId)) {
      throw new RuleValidationError(
        `accountId must be an integer or null, got ${JSON.stringify(accountId)}`,
      );
    }
    normAccount = accountId;
  }

  return {
    matchType,
    pattern: normPattern,
    minAmountMinor: normMin,
    maxAmountMinor: normMax,
    categoryId,
    accountId: normAccount,
    name: name == null ? '' : String(name),
  };
}

export function compileRule(row) {
  const matchType = row.match_type ?? row.matchType;
  let compiled = null;
  if (matchType === 'regex') {
    compiled = new RegExp(String(row.pattern ?? ''));
  }
  return { ...row, compiled };
}

export function loadRules(db) {
  const learned = db
    .prepare(
      `SELECT * FROM rules WHERE enabled = 1 AND source = 'learned'
       ORDER BY created_at DESC, id DESC`,
    )
    .all();
  const user = db
    .prepare(
      `SELECT * FROM rules WHERE enabled = 1 AND source = 'user'
       ORDER BY priority ASC, id ASC`,
    )
    .all();
  const out = [];
  for (const row of [...learned, ...user]) {
    try {
      out.push(compileRule(row));
    } catch {
      // disabled/broken rules are skipped silently, never crash evaluation
    }
  }
  return out;
}

export function matches(ruleCompiled, txn) {
  if (!ruleCompiled) return false;
  const t = txn ?? {};
  const ruleAccount = ruleCompiled.account_id ?? ruleCompiled.accountId;
  if (ruleAccount != null) {
    if (t.accountId == null || Number(t.accountId) !== Number(ruleAccount)) return false;
  }
  const matchType = ruleCompiled.match_type ?? ruleCompiled.matchType;
  switch (matchType) {
    case 'any':
      return true;
    case 'substring': {
      const hay = combinedText(t).toLowerCase();
      return hay.includes(String(ruleCompiled.pattern ?? '').toLowerCase());
    }
    case 'regex': {
      if (!(ruleCompiled.compiled instanceof RegExp)) return false;
      const hay = combinedText(t).slice(0, MATCH_INPUT_MAX);
      try {
        return ruleCompiled.compiled.test(hay);
      } catch {
        return false;
      }
    }
    case 'amount_range': {
      const amt = t.amountMinor;
      if (typeof amt !== 'number' || !Number.isFinite(amt)) return false;
      const min = ruleCompiled.min_amount_minor ?? ruleCompiled.minAmountMinor;
      const max = ruleCompiled.max_amount_minor ?? ruleCompiled.maxAmountMinor;
      if (min != null && amt < min) return false;
      if (max != null && amt > max) return false;
      return true;
    }
    default:
      return false;
  }
}

export function categorizeTransaction(rules, txn) {
  const list = Array.isArray(rules) ? rules : [];
  for (const rule of list) {
    if (matches(rule, txn)) {
      return {
        categoryId: rule.category_id ?? rule.categoryId ?? null,
        source: rule.source === 'learned' ? 'learned' : 'rule',
        ruleId: rule.id ?? null,
      };
    }
  }
  return { categoryId: null, source: null, ruleId: null };
}

export function applyRulesToUnprocessed(db) {
  const rules = loadRules(db);
  const rows = db
    .prepare(
      `SELECT id, account_id, date, payee, description, amount_minor
       FROM transactions
       WHERE category_id IS NULL AND category_source IS NULL AND manual = 0`,
    )
    .all();
  const update = db.prepare(
    `UPDATE transactions SET category_id = ?, category_source = ?, applied_rule_id = ?
     WHERE id = ? AND category_id IS NULL AND category_source IS NULL`,
  );
  let categorized = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const res = categorizeTransaction(rules, {
        accountId: row.account_id,
        date: row.date,
        payee: row.payee,
        description: row.description,
        amountMinor: row.amount_minor,
      });
      if (res.categoryId == null) continue;
      update.run(res.categoryId, res.source, res.ruleId, row.id);
      categorized += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // no active transaction
    }
    throw err;
  }
  return { categorized };
}

export function testRule(db, draftRule, sampleLimit = 50) {
  const normalized = validateRule(draftRule);
  const matcher = {
    match_type: normalized.matchType,
    pattern: normalized.pattern,
    min_amount_minor: normalized.minAmountMinor,
    max_amount_minor: normalized.maxAmountMinor,
    account_id: normalized.accountId,
    compiled: normalized.matchType === 'regex' ? new RegExp(normalized.pattern) : null,
  };
  const limit = Number.isInteger(sampleLimit) && sampleLimit >= 0 ? sampleLimit : 50;
  const rows = db
    .prepare(
      `SELECT id, date, payee, description, amount_minor, account_id
       FROM transactions ORDER BY date DESC`,
    )
    .all();
  let matchedCount = 0;
  const samples = [];
  for (const row of rows) {
    const hit = matches(matcher, {
      accountId: row.account_id,
      date: row.date,
      payee: row.payee,
      description: row.description,
      amountMinor: row.amount_minor,
    });
    if (!hit) continue;
    matchedCount += 1;
    if (samples.length < limit) {
      samples.push({ id: row.id, date: row.date, payee: row.payee, amountMinor: row.amount_minor });
    }
  }
  return { matchedCount, samples };
}

export const compileRules = loadRules;
