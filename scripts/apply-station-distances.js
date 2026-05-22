import pool from '../lib/db.js';

// 1. Backfill explore_pool.distance_meters from station_distances
const { rowCount: backfilled } = await pool.query(`
  UPDATE explore_pool ep
  SET distance_meters = sd.distance_meters
  FROM station_distances sd
  WHERE sd.start_station_id = ep.start_station_id
    AND sd.end_station_id   = ep.end_station_id
    AND ep.distance_meters IS NULL
    AND sd.distance_meters > 0
`);
console.log(`explore_pool: ${backfilled} rows backfilled`);

// 2. Report coverage
const { rows: [coverage] } = await pool.query(`
  SELECT
    COUNT(*)                                            AS total,
    COUNT(distance_meters)                              AS with_distance,
    COUNT(*) - COUNT(distance_meters)                   AS missing
  FROM explore_pool
`);
console.log(`explore_pool coverage: ${coverage.with_distance}/${coverage.total} have distance (${coverage.missing} missing)`);

await pool.end();
