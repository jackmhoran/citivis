#!/usr/bin/env node
// Re-runs route_stats maintenance for a specific period's trips.
// Use after a failed maintainRouteStats call (e.g. connection drop during ingest).
// Usage: node scripts/recover-route-stats.js 2026-05

import pool from '../lib/db.js';
import { maintainRouteStats } from '../lib/maintain-route-stats.js';

const period = process.argv[2];
if (!period) {
  console.error('Usage: node scripts/recover-route-stats.js <period>  (e.g. 2026-05)');
  process.exit(1);
}

const [year, month] = period.replace(/^JC-/, '').split('-');
const start = `${year}-${month}-01`;
const end = `${year}-${String(Number(month) + 1).padStart(2, '0')}-01`;

console.log(`Fetching affected pairs from trips for ${period}…`);
const { rows } = await pool.query(
  `SELECT DISTINCT start_station_id, end_station_id
   FROM trips
   WHERE started_at >= $1 AND started_at < $2`,
  [start, end]
);

if (!rows.length) {
  console.log('No trips found for that period.');
  process.exit(0);
}

const pairKeys = new Set(rows.map(r => `${r.start_station_id}|${r.end_station_id}`));
console.log(`Updating route_stats and trimming trips for ${pairKeys.size} affected pairs…`);
await maintainRouteStats(pool, pairKeys);
console.log('Done.');
await pool.end();
