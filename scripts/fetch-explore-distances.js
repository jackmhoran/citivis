import pool from '../lib/db.js';
import { fetchRouteDistance } from '../lib/osrm.js';

// Fetch at most this many routes (sorted by popularity, so the most-used routes get distances first)
const LIMIT = parseInt(process.env.LIMIT ?? '2000', 10);
// How many OSRM requests to fire in parallel
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '5', 10);

const { rows } = await pool.query(`
  SELECT ep.id, s1.lat AS slat, s1.lng AS slng, s2.lat AS elat, s2.lng AS elng
  FROM explore_pool ep
  JOIN stations s1 ON s1.id = ep.start_station_id
  JOIN stations s2 ON s2.id = ep.end_station_id
  WHERE ep.distance_meters IS NULL
    AND s1.lat IS NOT NULL AND s2.lat IS NOT NULL
  ORDER BY ep.trip_count DESC
  LIMIT $1
`, [LIMIT]);

console.log(`Fetching distances for ${rows.length} routes (concurrency=${CONCURRENCY})…`);
let updated = 0, failed = 0;

async function fetchOne(r) {
  const dist = await fetchRouteDistance(r.slng, r.slat, r.elng, r.elat);
  if (dist != null) {
    await pool.query('UPDATE explore_pool SET distance_meters = $1 WHERE id = $2', [dist, r.id]);
    updated++;
  } else {
    failed++;
  }
}

// Process in chunks of CONCURRENCY with a small gap between chunks
for (let i = 0; i < rows.length; i += CONCURRENCY) {
  const chunk = rows.slice(i, i + CONCURRENCY);
  await Promise.all(chunk.map(fetchOne));
  if ((i + CONCURRENCY) % 200 === 0)
    console.log(`  ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length}…`);
  if (i + CONCURRENCY < rows.length) await new Promise(r => setTimeout(r, 100));
}

await pool.end();
console.log(`Done — ${updated} updated, ${failed} failed.`);
