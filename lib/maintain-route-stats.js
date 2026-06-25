const PCTS = Array.from({ length: 10 }, (_, i) => (i + 1) * 10);
const PERCENTILE_COLS = PCTS.map(p =>
  `ROUND(PERCENTILE_CONT(${(p / 100).toFixed(2)}) WITHIN GROUP (ORDER BY duration_seconds)::numeric)::int AS p${p}`
).join(', ');
const PCT_INSERT_COLS = PCTS.map(p => `p${p}`).join(', ');
const PCT_UPDATE_COLS = PCTS.map(p => `p${p} = EXCLUDED.p${p}`).join(', ');

const BATCH_SIZE = 5000;

async function processBatch(pool, pairs) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TEMP TABLE _maint_pairs (
        start_station_id TEXT,
        end_station_id   TEXT
      ) ON COMMIT DROP
    `);

    const CHUNK = 1000;
    for (let i = 0; i < pairs.length; i += CHUNK) {
      const chunk = pairs.slice(i, i + CHUNK);
      const vals = chunk.map((_, idx) => `($${idx * 2 + 1},$${idx * 2 + 2})`).join(',');
      await client.query(`INSERT INTO _maint_pairs VALUES ${vals}`, chunk.flat());
    }

    await client.query(`
      INSERT INTO route_stats (
        start_station_id, end_station_id,
        trip_count, member_pct, min_seconds,
        ${PCT_INSERT_COLS}
      )
      SELECT
        t.start_station_id, t.end_station_id,
        COUNT(*)::int,
        ROUND(COUNT(*) FILTER (WHERE is_member) * 100.0 / NULLIF(COUNT(*), 0))::smallint,
        MIN(t.duration_seconds)::int,
        ${PERCENTILE_COLS}
      FROM trips t
      JOIN _maint_pairs mp
        ON mp.start_station_id = t.start_station_id
       AND mp.end_station_id   = t.end_station_id
      WHERE t.start_station_id != t.end_station_id
        AND t.duration_seconds > 0
      GROUP BY t.start_station_id, t.end_station_id
      ON CONFLICT (start_station_id, end_station_id) DO UPDATE SET
        trip_count  = EXCLUDED.trip_count,
        member_pct  = EXCLUDED.member_pct,
        min_seconds = EXCLUDED.min_seconds,
        ${PCT_UPDATE_COLS}
    `);

    await client.query(`
      DELETE FROM trips
      WHERE (start_station_id, end_station_id) IN (
        SELECT start_station_id, end_station_id FROM _maint_pairs
      )
        AND ride_id NOT IN (
          SELECT ride_id FROM (
            SELECT ride_id,
              ROW_NUMBER() OVER (PARTITION BY start_station_id, end_station_id ORDER BY duration_seconds ASC) AS rn_asc
            FROM trips
            WHERE (start_station_id, end_station_id) IN (
              SELECT start_station_id, end_station_id FROM _maint_pairs
            )
              AND duration_seconds > 0
          ) sub
          WHERE rn_asc <= 5
        )
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * After new trips are ingested, call this with the Set of affected "startId|endId" pair keys.
 * Processes in batches to avoid connection timeouts on large pair sets.
 */
export async function maintainRouteStats(pool, pairKeys) {
  if (!pairKeys || pairKeys.size === 0) return;

  const pairs = [...pairKeys].map(k => k.split('|'));

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const pct = Math.round(((i + batch.length) / pairs.length) * 100);
    process.stdout.write(`  route_stats batch ${i + batch.length}/${pairs.length} (${pct}%)…\r`);
    await processBatch(pool, batch);
  }
  process.stdout.write('\n');
}
