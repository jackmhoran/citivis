#!/usr/bin/env node
/**
 * Reduces trips to the 5 fastest rides per route pair.
 * Uses CREATE TABLE AS + DROP + RENAME to avoid long-running DELETE on a large table.
 * Run AFTER build-route-stats.js and AFTER validating route_stats looks correct.
 * This operation is irreversible.
 */
import pool from '../lib/db.js';

console.log('Trimming trips to top 5 fastest per route…');
console.log('This may take 10–30 minutes on a large table.');

const client = await pool.connect();

try {
  const { rows: [{ count: before }] } = await client.query('SELECT COUNT(*) FROM trips');
  console.log(`Before: ${Number(before).toLocaleString()} rows`);

  console.log('Creating trips_slim…');
  await client.query(`
    CREATE TABLE trips_slim AS
    SELECT ride_id, started_at, duration_seconds, start_station_id, end_station_id, is_member
    FROM (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY start_station_id, end_station_id ORDER BY duration_seconds ASC) AS rn_asc
      FROM trips
      WHERE start_station_id != end_station_id
        AND duration_seconds > 0
    ) sub
    WHERE rn_asc <= 5
  `);

  console.log('Swapping tables…');
  await client.query('DROP TABLE trips');
  await client.query('ALTER TABLE trips_slim RENAME TO trips');

  console.log('Recreating indexes…');
  await client.query('ALTER TABLE trips ADD PRIMARY KEY (ride_id)');
  await client.query(`
    ALTER TABLE trips
      ADD CONSTRAINT trips_start_station_id_fkey FOREIGN KEY (start_station_id) REFERENCES stations(id),
      ADD CONSTRAINT trips_end_station_id_fkey   FOREIGN KEY (end_station_id)   REFERENCES stations(id)
  `);
  const { rows: [{ count: after }] } = await client.query('SELECT COUNT(*) FROM trips');
  console.log(`Done — ${Number(after).toLocaleString()} rows kept (was ${Number(before).toLocaleString()})`);
} catch (err) {
  console.error('Error — trips table may be in inconsistent state:', err.message);
  throw err;
} finally {
  client.release();
  await pool.end();
}
