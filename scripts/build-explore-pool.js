import pool from '../lib/db.js';

console.log('Computing explore pool (this may take a minute)…');

const client = await pool.connect();

try {
  await client.query('BEGIN');

  // Source from route_stats (trips is trimmed to top 5 per pair, so COUNT(*) from trips
  // would always be ≤5 and never reach the 50-trip threshold).
  // p25/p75 are interpolated from adjacent deciles stored in route_stats.
  await client.query(`
    CREATE TEMP TABLE _new_pool ON COMMIT DROP AS
    SELECT
      start_station_id,
      end_station_id,
      trip_count,
      min_seconds,
      distance_meters,
      p10,
      (p20 + (p30 - p20) / 2)::int AS p25,
      p50,
      (p70 + (p80 - p70) / 2)::int AS p75,
      p90
    FROM route_stats
    WHERE trip_count >= 50
      AND start_station_id != end_station_id
  `);

  // Upsert stats. distance_meters comes from route_stats so update it too.
  const { rowCount: upserted } = await client.query(`
    INSERT INTO explore_pool (start_station_id, end_station_id, trip_count, min_seconds, distance_meters, p10, p25, p50, p75, p90)
    SELECT start_station_id, end_station_id, trip_count, min_seconds, distance_meters, p10, p25, p50, p75, p90
    FROM _new_pool
    ON CONFLICT (start_station_id, end_station_id) DO UPDATE SET
      trip_count     = EXCLUDED.trip_count,
      min_seconds    = EXCLUDED.min_seconds,
      distance_meters = EXCLUDED.distance_meters,
      p10 = EXCLUDED.p10,
      p25 = EXCLUDED.p25,
      p50 = EXCLUDED.p50,
      p75 = EXCLUDED.p75,
      p90 = EXCLUDED.p90
  `);

  // Remove routes that fell below 50-trip threshold
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
