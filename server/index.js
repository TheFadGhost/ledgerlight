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

// Final error handler (API errors are handled inside the router).
app.use((errObj, req, res, next) => {
  void next;
  console.error(errObj);
  if (res.headersSent) return;
  res.status(500).json({ error: 'INTERNAL', message: errObj.message });
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
