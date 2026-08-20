import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { migrate, pool, waitForDatabase } from './db.js';
import { createRouter } from './routes.js';
import { createRealtime } from './websocket.js';

const port = Number.parseInt(process.env.API_PORT || '3000', 10);
const app = express();
const server = http.createServer(app);
const realtime = createRealtime(server);

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', createRouter(realtime.presence));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Malformed JSON' });
  console.error(error);
  return res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  await waitForDatabase();
  await migrate();
  server.listen(port, '0.0.0.0', () => console.log(`API listening on ${port}`));
}

start().catch((error) => {
  console.error('Failed to start API', error);
  process.exit(1);
});

async function shutdown() {
  server.close();
  realtime.wss.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
