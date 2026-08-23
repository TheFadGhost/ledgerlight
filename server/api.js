import express from 'express';
import {
  listAccounts, createAccount, updateAccount, deleteAccount, accountBalances,
} from '../src/server/accounts.js';
import { listCategories, createCategory, updateCategory } from '../src/server/categories.js';
import {
  queryTransactions, getTransaction, updateTransactionCategory,
  bulkCategorize, splitTransaction, unsplitTransaction, createManualTransaction,
  popUndo,
} from '../src/server/transactions.js';
import { previewImport, commitImport } from '../src/import/importer.js';
import { saveProfile, listProfiles, updateProfile, deleteProfile } from '../src/import/profiles.js';
import {
  listRulesWithCategories, createRule, updateRule, deleteRule, testRuleDraft,
} from '../src/server/rules.js';
import {
  monthSummaries, spendByCategory, spendOverTime, topMerchants,
  momChanges, uncategorizedSummary,
} from '../src/analytics/aggregate.js';
import { detectRecurring } from '../src/analytics/recurring.js';
import { budgetStatus, setBudget, deleteBudget, uncategorizedInMonth } from '../src/analytics/budgets.js';
import { getSettings, putSettings } from '../src/server/settings.js';
import {
  createBackup, restoreBackup, exportTransactionsCsv, exportTransactionsJson,
} from '../src/backup.js';

export function buildApi(db, { dbPath }) {
  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));

  const wrap = (fn) => (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      const validationNames = ['ImportError', 'RuleValidationError', 'BackupError', 'MoneyFormatError', 'DateFormatError', 'TypeError', 'RangeError'];
      const status = err.status ?? (validationNames.includes(err.name) ? 400 : 500);
      res.status(status).json({
        error: err.code || err.name || 'INTERNAL',
        message: err.message,
        details: err.details ?? err.meta ?? undefined,
      });
    }
  };

  const httpError = (status, code, message, details) => {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    e.details = details;
    return e;
  };

  // ---- meta -------------------------------------------------------------
  api.get('/meta', wrap((req, res) => {
    const counts = {};
    for (const t of ['accounts', 'categories', 'transactions', 'rules', 'budgets', 'profiles']) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    }
    res.json({
      app: 'ledgerlight',
      dbPath,
      counts,
      dataDirNote: 'All data lives in the SQLite file above on this machine only.',
    });
  }));

  // ---- accounts ---------------------------------------------------------
  api.get('/accounts', wrap((req, res) => res.json(listAccounts(db))));
  api.get('/accounts/balances', wrap((req, res) => res.json(accountBalances(db))));
  api.post('/accounts', wrap((req, res) => res.status(201).json(createAccount(db, req.body))));
  api.patch('/accounts/:id', wrap((req, res) => {
    res.json(updateAccount(db, Number(req.params.id), req.body));
  }));
  api.delete('/accounts/:id', wrap((req, res) => {
    deleteAccount(db, Number(req.params.id));
    res.status(204).end();
  }));

  // ---- categories -------------------------------------------------------
  api.get('/categories', wrap((req, res) => res.json(listCategories(db))));
  api.post('/categories', wrap((req, res) => res.status(201).json(createCategory(db, req.body))));
  api.patch('/categories/:id', wrap((req, res) => {
    res.json(updateCategory(db, Number(req.params.id), req.body));
  }));

  // ---- transactions -----------------------------------------------------
  api.get('/transactions', wrap((req, res) => {
    res.json(queryTransactions(db, req.query));
  }));
  api.get('/transactions/:id', wrap((req, res) => {
    const t = getTransaction(db, Number(req.params.id));
    if (!t) throw httpError(404, 'NOT_FOUND', 'No such transaction');
    res.json(t);
  }));
  api.patch('/transactions/:id', wrap((req, res) => {
    res.json(updateTransactionCategory(db, Number(req.params.id), req.body));
  }));
  api.post('/transactions/bulk', wrap((req, res) => {
    res.json(bulkCategorize(db, req.body));
  }));
  api.post('/transactions/:id/split', wrap((req, res) => {
    res.status(201).json(splitTransaction(db, Number(req.params.id), req.body));
  }));
  api.delete('/transactions/:id/split', wrap((req, res) => {
    res.json(unsplitTransaction(db, Number(req.params.id)));
  }));
  api.post('/transactions/manual', wrap((req, res) => {
    res.status(201).json(createManualTransaction(db, req.body));
  }));

  // ---- rules ------------------------------------------------------------
  api.get('/rules', wrap((req, res) => res.json(listRulesWithCategories(db))));
  api.post('/rules', wrap((req, res) => res.status(201).json(createRule(db, req.body))));
  api.post('/rules/test', wrap((req, res) => res.json(testRuleDraft(db, req.body))));
  api.patch('/rules/:id', wrap((req, res) => {
    res.json(updateRule(db, Number(req.params.id), req.body));
  }));
  api.delete('/rules/:id', wrap((req, res) => {
    deleteRule(db, Number(req.params.id));
    res.status(204).end();
  }));

  // ---- profiles & import ------------------------------------------------
  api.get('/profiles', wrap((req, res) => res.json(listProfiles(db))));
  api.post('/profiles', wrap((req, res) => res.status(201).json(saveProfile(db, req.body))));
  api.patch('/profiles/:id', wrap((req, res) => {
    res.json(updateProfile(db, Number(req.params.id), req.body));
  }));
  api.delete('/profiles/:id', wrap((req, res) => {
    deleteProfile(db, Number(req.params.id));
    res.status(204).end();
  }));

  // CSV content arrives as JSON { content: <utf8 text> } (local-only tool).
  api.post('/import/preview', wrap((req, res) => {
    const { content, ...opts } = req.body || {};
    if (typeof content !== 'string' || content.length === 0) {
      throw httpError(400, 'EMPTY_FILE', 'Request body must be JSON with a non-empty `content` string');
    }
    if (content.length > 64 * 1024 * 1024) {
      throw httpError(413, 'FILE_TOO_LARGE', 'CSV larger than 64 MB');
    }
    res.json(previewImport(db, Buffer.from(content, 'utf8'), opts));
  }));
  api.post('/import/commit', wrap((req, res) => {
    const { content, ...opts } = req.body || {};
    if (typeof content !== 'string' || content.length === 0) {
      throw httpError(400, 'EMPTY_FILE', 'Request body must be JSON with a non-empty `content` string');
    }
    res.json(commitImport(db, Buffer.from(content, 'utf8'), opts));
  }));

  // ---- dashboard & analytics -------------------------------------------
  api.get('/dashboard', wrap((req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : null;
    const m = month || new Date().toISOString().slice(0, 7);
    const prev = (() => {
      const [y, mo] = m.split('-').map(Number);
      const d = new Date(Date.UTC(y, mo - 2, 1));
      return d.toISOString().slice(0, 7);
    })();
    const yearStart = `${m.slice(0, 4)}-01`;
    res.json({
      month: m,
      previousMonth: prev,
      summary: monthSummaries(db, yearStart <= prev ? yearStart : prev, m),
      byCategory: spendByCategory(db, m, { limit: 12 }),
      overTime: spendOverTime(db, `${m}-01`, lastDayOf(m)),
      topMerchants: topMerchants(db, `${m}-01`, lastDayOf(m), { limit: 8 }),
      mom: momChanges(db, m),
      uncategorized: uncategorizedSummary(db),
      budgets: budgetStatus(db, m),
    });
  }));

  api.get('/recurring', wrap((req, res) => {
    res.json(detectRecurring(db, { lookbackDays: Number(req.query.lookbackDays) || 180 }));
  }));

  // ---- budgets ----------------------------------------------------------
  api.get('/budgets', wrap((req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
    res.json({ month, budgets: budgetStatus(db, month), uncategorized: uncategorizedInMonth(db, month) });
  }));
  api.put('/budgets', wrap((req, res) => {
    const { categoryId, monthlyAmountMinor } = req.body || {};
    res.status(201).json(setBudget(db, Number(categoryId), monthlyAmountMinor));
  }));
  api.delete('/budgets/:categoryId', wrap((req, res) => {
    deleteBudget(db, Number(req.params.categoryId));
    res.status(204).end();
  }));

  // ---- settings ---------------------------------------------------------
  api.get('/settings', wrap((req, res) => res.json(getSettings(db))));
  api.put('/settings', wrap((req, res) => res.json(putSettings(db, req.body))));

  // ---- undo -------------------------------------------------------------
  api.post('/undo', wrap((req, res) => {
    res.json(popUndo(db));
  }));

  // ---- export / backup --------------------------------------------------
  api.get('/export.csv', wrap((req, res) => {
    const csv = exportTransactionsCsv(db, req.query);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="ledgerlight-transactions.csv"');
    res.send(csv);
  }));
  api.get('/export.json', wrap((req, res) => {
    res.json(exportTransactionsJson(db, req.query));
  }));
  api.get('/backup', wrap((req, res) => {
    res.set('Content-Disposition', 'attachment; filename="ledgerlight-backup.json"');
    res.json(createBackup(db));
  }));
  api.post('/restore', wrap((req, res) => {
    res.json(restoreBackup(db, req.body));
  }));

  api.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: `No route ${req.method} ${req.path}` }));
  return api;
}

function lastDayOf(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${monthKey}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
