import { readFileSync } from 'fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import stationsRouter from './routes/stations.js';

const app = new Hono();

app.route('/api/stations', stationsRouter);

app.get('/', (c) => c.html(readFileSync('./public/index.html', 'utf8')));

const PORT = parseInt(process.env.PORT ?? '3000', 10);
serve({ fetch: app.fetch, port: PORT });
console.log(`Server running on http://localhost:${PORT}`);
