const PCTS = Array.from({ length: 20 }, (_, i) => (i + 1) * 5);

const PERCENTILE_COLS = PCTS
  .map(p => `ROUND((PERCENTILE_CONT(${(p / 100).toFixed(2)}) WITHIN GROUP (ORDER BY duration_seconds))::numeric) AS p${p}`)
  .join(',\n  ');

const VALID_TIMEFRAMES = new Set(['alltime', 'year', 'month', 'day']);

function buildBase(startId, endId, dateRef, timeframe) {
  if (!VALID_TIMEFRAMES.has(timeframe)) {
    throw new Error(`Invalid timeframe "${timeframe}". Use: alltime, year, month, day`);
  }
  const params = [startId, endId];
  let where = 'start_station_id = $1 AND end_station_id = $2';

  if (timeframe !== 'alltime' && dateRef) {
    params.push(dateRef);
    where += ` AND DATE_TRUNC('${timeframe}', started_at) = DATE_TRUNC('${timeframe}', $3::timestamptz)`;
  }

  return { where, params };
}

export async function getClosestStations(pool, lat, lng) {
  const { rows } = await pool.query(`
    SELECT
      id, name, lat, lng,
      ROUND(SQRT(
        POWER((lat - $1) * 111320, 2) +
        POWER((lng - $2) * 111320 * COS(RADIANS($1)), 2)
      )::numeric) AS distance_meters
    FROM stations
    WHERE lat IS NOT NULL AND lng IS NOT NULL
    ORDER BY
      POWER((lat - $1) * 111320, 2) +
      POWER((lng - $2) * 111320 * COS(RADIANS($1)), 2)
    LIMIT 10
  `, [lat, lng]);
  return rows;
}

export async function getRandomStation(pool) {
  const { rows } = await pool.query(
    'SELECT id, name, lat, lng FROM stations ORDER BY RANDOM() LIMIT 1'
  );
  return rows[0] ?? null;
}

export async function getMaxDate(pool, startId, endId) {
  const { rows } = await pool.query(
    'SELECT MAX(started_at) AS max_date FROM trips WHERE start_station_id = $1 AND end_station_id = $2',
    [startId, endId]
  );
  return rows[0]?.max_date ?? null;
}

const STATION_SQL = 'SELECT id, name, lat, lng FROM stations WHERE id = $1';

export async function getRouteStats(pool, startId, endId, dateRef, timeframe) {
  const { where, params } = buildBase(startId, endId, dateRef, timeframe);

  const [countRes, fastestRes, slowestRes, pctRes, startRes, endRes, distRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count, ROUND(COUNT(*) FILTER (WHERE member_casual = 'member') * 100.0 / NULLIF(COUNT(*), 0)) AS member_pct FROM trips WHERE ${where}`, params),
    pool.query(`SELECT ride_id, duration_seconds, started_at FROM trips WHERE ${where} ORDER BY duration_seconds ASC LIMIT 10`, params),
    pool.query(`SELECT ride_id, duration_seconds, started_at FROM trips WHERE ${where} ORDER BY duration_seconds DESC LIMIT 10`, params),
    pool.query(`SELECT ${PERCENTILE_COLS} FROM trips WHERE ${where}`, params),
    pool.query(STATION_SQL, [startId]),
    pool.query(STATION_SQL, [endId]),
    pool.query('SELECT distance_meters FROM station_distances WHERE start_station_id = $1 AND end_station_id = $2', [startId, endId]),
  ]);

  const pctRow = pctRes.rows[0] ?? {};
  const percentiles = {};
  for (const p of PCTS) {
    const v = pctRow[`p${p}`];
    percentiles[`p${p}`] = v != null ? Number(v) : null;
  }

  return {
    startStation: startRes.rows[0] ?? null,
    endStation:   endRes.rows[0]   ?? null,
    distanceMeters: distRes.rows[0]?.distance_meters ?? null,
    count: countRes.rows[0]?.count ?? 0,
    memberPct: countRes.rows[0]?.member_pct != null ? Number(countRes.rows[0].member_pct) : null,
    top10fastest: fastestRes.rows,
    top10slowest: slowestRes.rows,
    percentiles,
  };
}

export async function getAllStations(pool) {
  const { rows } = await pool.query(
    'SELECT id, name, lat, lng FROM stations WHERE lat BETWEEN 40.4 AND 41.0 AND lng BETWEEN -74.3 AND -73.6 ORDER BY name'
  );
  return rows;
}

export async function getStationDestinations(pool, startId) {
  const { rows } = await pool.query(`
    SELECT
      t.end_station_id AS "endStationId",
      s.name, s.lat, s.lng,
      COUNT(*)::int AS "tripCount",
      sd.distance_meters AS "distanceMeters"
    FROM trips t
    JOIN stations s ON s.id = t.end_station_id
    LEFT JOIN station_distances sd
      ON sd.start_station_id = $1
     AND sd.end_station_id   = t.end_station_id
    WHERE t.start_station_id = $1
      AND t.end_station_id != $1
      AND s.lat IS NOT NULL AND s.lng IS NOT NULL
    GROUP BY t.end_station_id, s.name, s.lat, s.lng, sd.distance_meters
    ORDER BY COUNT(*) DESC
  `, [startId]);
  return rows;
}

export async function getPopularRoutes(pool, minFastest = 0) {
  const { rows } = await pool.query(`
    SELECT
      t.start_station_id AS "startStationId",
      t.end_station_id   AS "endStationId",
      s1.name            AS "startName",
      s2.name            AS "endName",
      COUNT(*)::int      AS "tripCount",
      MIN(t.duration_seconds)::int AS "fastestSeconds"
    FROM trips t
    JOIN stations s1 ON s1.id = t.start_station_id
    JOIN stations s2 ON s2.id = t.end_station_id
    GROUP BY t.start_station_id, t.end_station_id, s1.name, s2.name
    HAVING MIN(t.duration_seconds) >= $1
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `, [minFastest]);
  return rows;
}

export async function getAllRouteRides(pool, startId, endId) {
  const { rows } = await pool.query(
    'SELECT ride_id, duration_seconds, started_at FROM trips WHERE start_station_id = $1 AND end_station_id = $2 ORDER BY duration_seconds ASC',
    [startId, endId]
  );
  return rows;
}

export async function getRouteCompare(pool, startId, endId, duration, dateRef, timeframe) {
  const { where, params: baseParams } = buildBase(startId, endId, dateRef, timeframe);
  const dIdx = baseParams.length + 1;
  const params = [...baseParams, duration];

  const [countRes, pctRankRes, fastestRes, slowestRes, nearestRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM trips WHERE ${where}`, baseParams),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE duration_seconds < $${dIdx}) * 100.0 / NULLIF(COUNT(*), 0) AS percentile_rank FROM trips WHERE ${where}`,
      params
    ),
    pool.query(`SELECT ride_id, duration_seconds FROM trips WHERE ${where} ORDER BY duration_seconds ASC LIMIT 5`, baseParams),
    pool.query(`SELECT ride_id, duration_seconds FROM trips WHERE ${where} ORDER BY duration_seconds DESC LIMIT 5`, baseParams),
    pool.query(`SELECT ride_id, duration_seconds FROM trips WHERE ${where} ORDER BY ABS(duration_seconds - $${dIdx}) LIMIT 10`, params),
  ]);

  return {
    count: countRes.rows[0]?.count ?? 0,
    percentileRank: parseFloat(pctRankRes.rows[0]?.percentile_rank ?? 0),
    top5fastest: fastestRes.rows,
    top5slowest: slowestRes.rows,
    nearest10: nearestRes.rows,
  };
}

const VALID_SORTS = new Set(['popular', 'speed']);

export async function getExploreRoutes(pool, { borough, neighborhood, minMedian = 300, sort = 'popular' } = {}) {
  if (!VALID_SORTS.has(sort)) throw new Error(`Invalid sort "${sort}". Use: popular, speed`);

  const conditions = ['ep.p50 >= $1', 'ep.start_station_id != ep.end_station_id'];
  const params = [minMedian];

  if (borough) {
    params.push(borough);
    conditions.push(`(s1.borough = $${params.length} OR s2.borough = $${params.length})`);
  }
  if (neighborhood) {
    params.push(neighborhood);
    conditions.push(`(s1.neighborhood = $${params.length} OR s2.neighborhood = $${params.length})`);
  }

  const orderBy = sort === 'speed'
    ? '(ep.distance_meters::float / NULLIF(ep.p50, 0)) DESC NULLS LAST'
    : 'ep.trip_count DESC';

  const { rows } = await pool.query(`
    SELECT
      ep.start_station_id  AS "startStationId",
      ep.end_station_id    AS "endStationId",
      s1.name              AS "startName",
      s2.name              AS "endName",
      s1.borough           AS "startBorough",
      s1.neighborhood      AS "startNeighborhood",
      s2.borough           AS "endBorough",
      s2.neighborhood      AS "endNeighborhood",
      s1.lat AS "startLat", s1.lng AS "startLng",
      s2.lat AS "endLat",   s2.lng AS "endLng",
      ep.trip_count    AS "tripCount",
      ep.min_seconds   AS "minSeconds",
      ep.distance_meters AS "distanceMeters",
      ep.p10, ep.p25, ep.p50, ep.p75, ep.p90
    FROM explore_pool ep
    JOIN stations s1 ON s1.id = ep.start_station_id
    JOIN stations s2 ON s2.id = ep.end_station_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT 50
  `, params);
  return rows;
}

export async function getExploreMeta(pool) {
  const { rows } = await pool.query(`
    SELECT DISTINCT s.borough, s.neighborhood
    FROM stations s
    WHERE s.borough IS NOT NULL
      AND (
        EXISTS (SELECT 1 FROM explore_pool ep WHERE ep.start_station_id = s.id)
        OR
        EXISTS (SELECT 1 FROM explore_pool ep WHERE ep.end_station_id   = s.id)
      )
    ORDER BY s.borough, s.neighborhood
  `);
  const meta = {};
  for (const r of rows) {
    if (!meta[r.borough]) meta[r.borough] = [];
    if (r.neighborhood) meta[r.borough].push(r.neighborhood);
  }
  return meta;
}
