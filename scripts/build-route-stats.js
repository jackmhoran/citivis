#!/usr/bin/env node
import pool from '../lib/db.js';

const PCTS = Array.from({ length: 10 }, (_, i) => (i + 1) * 10);

const PERCENTILE_COLS = PCTS
  .map(p => `ROUND(PERCENTILE_CONT(${(p / 100).toFixed(2)}) WITHIN GROUP (ORDER BY duration_seconds)::numeric)::int AS p${p}`)
  .join(', ');

const PCT_INSERT_COLS = PCTS.map(p => `p${p}`).join(', ');
const PCT_UPDATE_COLS = PCTS.map(p => `p${p} = EXCLUDED.p${p}`).join(', ');

console.log('Building route_stats from trips + station_distances…');
console.log('(This will take several minutes on a large trips table.)');

const client = await pool.connect();

try {
  await client.query('BEGIN');

  await client.query(`
    CREATE TEMP TABLE _route_stats ON COMMIT DROP AS
    SELECT
      t.start_station_id,
      t.end_station_id,
      COUNT(*)::int                                                               AS trip_count,
      ROUND(COUNT(*) FILTER (WHERE is_member) * 100.0
        / NULLIF(COUNT(*), 0))::smallint                                          AS member_pct,
      MIN(t.duration_seconds)::int                                                AS min_seconds,
      sd.distance_meters,
      ${PERCENTILE_COLS}
    FROM trips t
    LEFT JOIN station_distances sd
      ON sd.start_station_id = t.start_station_id
     AND sd.end_station_id   = t.end_station_id
    WHERE t.start_station_id != t.end_station_id
    GROUP BY t.start_station_id, t.end_station_id, sd.distance_meters
  `);

  const { rowCount } = await client.query(`
    INSERT INTO route_stats (
      start_station_id, end_station_id,
      trip_count, member_pct, min_seconds, distance_meters,
      ${PCT_INSERT_COLS}
    )
    SELECT
      start_station_id, end_station_id,
      trip_count, member_pct, min_seconds, distance_meters,
      ${PCT_INSERT_COLS}
    FROM _route_stats
    ON CONFLICT (start_station_id, end_station_id) DO UPDATE SET
      trip_count      = EXCLUDED.trip_count,
      member_pct      = EXCLUDED.member_pct,
      min_seconds     = EXCLUDED.min_seconds,
      distance_meters = EXCLUDED.distance_meters,
      ${PCT_UPDATE_COLS}
  `);

  await client.query('COMMIT');
  console.log(`Done — ${rowCount} routes upserted into route_stats.`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await pool.end();
}
