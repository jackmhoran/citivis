import pool from '../lib/db.js';

console.log('Computing explore pool (this may take a minute)…');

const client = await pool.connect();

try {
  await client.query('BEGIN');

  // Compute the full eligible route set into a temp table
  await client.query(`
    CREATE TEMP TABLE _new_pool ON COMMIT DROP AS
    WITH eligible AS (
      SELECT start_station_id, end_station_id, COUNT(*)::int AS trip_count
      FROM trips
      WHERE start_station_id != end_station_id
      GROUP BY start_station_id, end_station_id
      HAVING COUNT(*) >= 50
    )
    SELECT
      e.start_station_id,
      e.end_station_id,
      e.trip_count,
      MIN(t.duration_seconds)::int                                                           AS min_seconds,
      ROUND(PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY t.duration_seconds)::numeric)::int AS p10,
      ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY t.duration_seconds)::numeric)::int AS p25,
      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY t.duration_seconds)::numeric)::int AS p50,
      ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY t.duration_seconds)::numeric)::int AS p75,
      ROUND(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY t.duration_seconds)::numeric)::int AS p90
    FROM eligible e
    JOIN trips t ON t.start_station_id = e.start_station_id AND t.end_station_id = e.end_station_id
    GROUP BY e.start_station_id, e.end_station_id, e.trip_count
  `);

  // Upsert: update stats for existing routes, insert new ones.
  // distance_meters is intentionally excluded so fetched OSRM values are preserved.
  const { rowCount: upserted } = await client.query(`
    INSERT INTO explore_pool (start_station_id, end_station_id, trip_count, min_seconds, p10, p25, p50, p75, p90)
    SELECT start_station_id, end_station_id, trip_count, min_seconds, p10, p25, p50, p75, p90
    FROM _new_pool
    ON CONFLICT (start_station_id, end_station_id) DO UPDATE SET
      trip_count  = EXCLUDED.trip_count,
      min_seconds = EXCLUDED.min_seconds,
      p10 = EXCLUDED.p10,
      p25 = EXCLUDED.p25,
      p50 = EXCLUDED.p50,
      p75 = EXCLUDED.p75,
      p90 = EXCLUDED.p90
  `);

  // Remove routes that are no longer eligible (below the 50-trip threshold)
  const { rowCount: deleted } = await client.query(`
    DELETE FROM explore_pool ep
    WHERE NOT EXISTS (
      SELECT 1 FROM _new_pool np
      WHERE np.start_station_id = ep.start_station_id
        AND np.end_station_id   = ep.end_station_id
    )
  `);

  await client.query('COMMIT');
  console.log(`Done — ${upserted} routes upserted, ${deleted} stale routes removed.`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await pool.end();
}
