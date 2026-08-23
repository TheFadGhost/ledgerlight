import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, schemaVersion, DEFAULT_DB_PATH } from '../src/core/db.js';
import { seedTaxonomy } from '../src/core/seed.js';
import { buildApi } from './api.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.LEDGERLIGHT_DB || DEFAULT_DB_PATH;
const db = openDb(dbPath);
seedTaxonomy(db);

const app = express();
app.disable('x-powered-by');

app.use('/api', buildApi(db, { dbPath }));

const pub = join(root, 'public');
app.use(express.static(pub));
app.get('*', (req, res) => res.sendFile(join(pub, 'index.html')));

// Body-parser and router-level errors arrive here with err.type/type codes.
app.use((errObj, req, res, next) => {
  void next;
  if (res.headersSent) return;
  let status = errObj.status || 500;
  let code = errObj.code || 'INTERNAL';
  let message = errObj.message || 'Internal error';
  if (errObj.type === 'entity.too.large') { status = 413; code = 'FILE_TOO_LARGE'; }
  else if (errObj.type === 'entity.parse.failed') { status = 400; code = 'BAD_JSON'; message = 'Request body is not valid JSON'; }
  if (status >= 500) console.error(errObj);
  res.status(status).json({ error: code, message });
});

const PORT = Number(process.env.PORT) || 7781;
const server = app.listen(PORT, () => {
  console.log(`Ledgerlight running at http://localhost:${PORT}`);
  console.log(`Database file: ${dbPath} (schema v${schemaVersion(db)})`);
  console.log('All data stays in that local file on this machine.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
