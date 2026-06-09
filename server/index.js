import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.static(PUBLIC_DIR));

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'eagle-crash', step: 1 });
});

const server = app.listen(PORT, () => {
  console.log(`[eagle-crash] http://localhost:${PORT}`);
});

const shutdown = (signal) => {
  console.log(`\n[eagle-crash] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
