import { readFileSync } from 'fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import stationsRouter from './routes/stations.js';

const LIMIT = 60;       // requests
const WINDOW = 60_000;  // ms

const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now >= entry.resetAt) hits.delete(ip);
  }
}, WINDOW).unref();

const app = new Hono();

app.use('*', (c, next) => {
  const ip = c.req.header('cf-connecting-ip')
    ?? c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? 'unknown';
  const now = Date.now();
  const entry = hits.get(ip) ?? { count: 0, resetAt: now + WINDOW };
  if (now >= entry.resetAt) { entry.count = 0; entry.resetAt = now + WINDOW; }
  entry.count++;
  hits.set(ip, entry);
  if (entry.count > LIMIT) return c.json({ error: 'rate limit exceeded' }, 429);
  return next();
});

app.route('/api/stations', stationsRouter);

app.get('/', (c) => c.html(readFileSync('./public/index.html', 'utf8')));

const PORT = parseInt(process.env.PORT ?? '3000', 10);
serve({ fetch: app.fetch, port: PORT });
console.log(`Server running on http://localhost:${PORT}`);
