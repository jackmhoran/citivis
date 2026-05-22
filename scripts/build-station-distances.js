import pool from '../lib/db.js';
import { fetchDistanceTable } from '../lib/osrm.js';

if (!process.env.OSRM_URL) {
  console.warn('Warning: OSRM_URL not set — using public API (slow, rate-limited for large tables).');
  console.warn('For full station matrix, run with: OSRM_URL=http://localhost:5000');
}

const BATCH = parseInt(process.env.BATCH ?? '100', 10);
const CHUNK = 1000;

const { rows: stations } = await pool.query(
  'SELECT id, lat, lng FROM stations WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY id'
);
const n = stations.length;
console.log(`${n} stations → up to ${n * (n - 1)} directed pairs…`);

const coords = stations.map(s => ({ lng: +s.lng, lat: +s.lat }));
const matrix = await fetchDistanceTable(coords, BATCH);

const pairs = [];
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const dist = matrix[i][j];
    if (dist != null) pairs.push([stations[i].id, stations[j].id, dist]);
  }
}
console.log(`${pairs.length} non-null pairs — upserting…`);

let inserted = 0;
for (let k = 0; k < pairs.length; k += CHUNK) {
  const chunk = pairs.slice(k, k + CHUNK);
  const vals = chunk.map((_, idx) => `($${idx * 3 + 1},$${idx * 3 + 2},$${idx * 3 + 3})`).join(',');
  await pool.query(
    `INSERT INTO station_distances (start_station_id, end_station_id, distance_meters)
     VALUES ${vals}
     ON CONFLICT (start_station_id, end_station_id)
     DO UPDATE SET distance_meters = EXCLUDED.distance_meters`,
    chunk.flat()
  );
  inserted += chunk.length;
  if (inserted % 100_000 === 0) console.log(`  upserted ${inserted}/${pairs.length}…`);
}

await pool.end();
console.log(`Done — ${inserted} pairs upserted.`);
