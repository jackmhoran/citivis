import pool from '../lib/db.js';
import { fetchRouteDistance } from '../lib/osrm.js';

const LIMIT = parseInt(process.env.LIMIT ?? '5000', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '5', 10);

const { rows } = await pool.query(`
  SELECT rs.start_station_id, rs.end_station_id,
         s1.lat AS slat, s1.lng AS slng,
         s2.lat AS elat, s2.lng AS elng
  FROM route_stats rs
  JOIN stations s1 ON s1.id = rs.start_station_id
  JOIN stations s2 ON s2.id = rs.end_station_id
  WHERE rs.distance_meters IS NULL
    AND s1.lat IS NOT NULL AND s2.lat IS NOT NULL
  ORDER BY rs.trip_count DESC
  LIMIT $1
`, [LIMIT]);

console.log(`Fetching distances for ${rows.length} route_stats rows (concurrency=${CONCURRENCY})…`);
let updated = 0, failed = 0;

async function fetchOne(r) {
  const dist = await fetchRouteDistance(r.slng, r.slat, r.elng, r.elat);
  if (dist != null) {
    await pool.query(
      `UPDATE route_stats SET distance_meters = $1
       WHERE start_station_id = $2 AND end_station_id = $3`,
      [dist, r.start_station_id, r.end_station_id]
    );
    updated++;
  } else {
    failed++;
  }
}

for (let i = 0; i < rows.length; i += CONCURRENCY) {
  const chunk = rows.slice(i, i + CONCURRENCY);
  await Promise.all(chunk.map(fetchOne));
  if ((i + CONCURRENCY) % 500 === 0)
    console.log(`  ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length}…`);
  if (i + CONCURRENCY < rows.length) await new Promise(r => setTimeout(r, 100));
}

await pool.end();
console.log(`Done — ${updated} updated, ${failed} failed.`);
