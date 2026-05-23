const PCTS = Array.from({ length: 10 }, (_, i) => (i + 1) * 10);
const PCT_SELECT = PCTS.map(p => `rs.p${p}`).join(', ');

function interpolatePercentileRank(stats, duration) {
  if (duration <= stats.min_seconds) return 0;
  if (duration >= stats.p100) return 100;
  for (let i = 0; i < PCTS.length; i++) {
    const p = PCTS[i];
    const val = Number(stats[`p${p}`]);
    if (duration <= val) {
      const prevP = i === 0 ? 0 : PCTS[i - 1];
      const prevVal = i === 0 ? Number(stats.min_seconds) : Number(stats[`p${prevP}`]);
      if (val === prevVal) return prevP;
      return prevP + (p - prevP) * (duration - prevVal) / (val - prevVal);
    }
  }
  return 95;
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

const STATION_SQL = 'SELECT id, name, lat, lng FROM stations WHERE id = $1';

export async function getRouteStats(pool, startId, endId) {
  const [statsRes, fastestRes, startRes, endRes] = await Promise.all([
    pool.query(
      `SELECT rs.trip_count, rs.member_pct, rs.distance_meters, ${PCT_SELECT}
       FROM route_stats rs
       WHERE rs.start_station_id = $1 AND rs.end_station_id = $2`,
      [startId, endId]
    ),
    pool.query(
      'SELECT ride_id, duration_seconds, started_at FROM trips WHERE start_station_id = $1 AND end_station_id = $2 ORDER BY duration_seconds ASC LIMIT 5',
      [startId, endId]
    ),
    pool.query(STATION_SQL, [startId]),
    pool.query(STATION_SQL, [endId]),
  ]);

  const sr = statsRes.rows[0] ?? {};
  const percentiles = {};
  for (const p of PCTS) {
    const v = sr[`p${p}`];
    percentiles[`p${p}`] = v != null ? Number(v) : null;
  }

  return {
    startStation:   startRes.rows[0] ?? null,
    endStation:     endRes.rows[0]   ?? null,
    distanceMeters: sr.distance_meters ?? null,
    count:          sr.trip_count ?? 0,
    memberPct:      sr.member_pct != null ? Number(sr.member_pct) : null,
    top5fastest:    fastestRes.rows,
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
      rs.end_station_id      AS "endStationId",
      s.name, s.lat, s.lng,
      rs.trip_count          AS "tripCount",
      rs.distance_meters     AS "distanceMeters"
    FROM route_stats rs
    JOIN stations s ON s.id = rs.end_station_id
    WHERE rs.start_station_id = $1
      AND rs.end_station_id  != $1
      AND s.lat IS NOT NULL AND s.lng IS NOT NULL
    ORDER BY rs.trip_count DESC
  `, [startId]);
  return rows;
}

export async function getPopularRoutes(pool, minFastest = 0) {
  const { rows } = await pool.query(`
    SELECT
      rs.start_station_id AS "startStationId",
      rs.end_station_id   AS "endStationId",
      s1.name             AS "startName",
      s2.name             AS "endName",
      rs.trip_count       AS "tripCount",
      rs.min_seconds      AS "fastestSeconds"
    FROM route_stats rs
    JOIN stations s1 ON s1.id = rs.start_station_id
    JOIN stations s2 ON s2.id = rs.end_station_id
    WHERE rs.min_seconds >= $1
    ORDER BY rs.trip_count DESC
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

export async function getRouteCompare(pool, startId, endId, duration) {
  const [statsRes, fastestRes, nearestRes] = await Promise.all([
    pool.query(
      `SELECT rs.trip_count, rs.min_seconds, ${PCT_SELECT}
       FROM route_stats rs
       WHERE rs.start_station_id = $1 AND rs.end_station_id = $2`,
      [startId, endId]
    ),
    pool.query(
      'SELECT ride_id, duration_seconds FROM trips WHERE start_station_id = $1 AND end_station_id = $2 ORDER BY duration_seconds ASC LIMIT 5',
      [startId, endId]
    ),
    pool.query(
      'SELECT ride_id, duration_seconds FROM trips WHERE start_station_id = $1 AND end_station_id = $2 ORDER BY ABS(duration_seconds - $3) LIMIT 5',
      [startId, endId, duration]
    ),
  ]);

  const sr = statsRes.rows[0];
  const percentileRank = sr ? interpolatePercentileRank(sr, duration) : 0;

  return {
    count:          sr?.trip_count ?? 0,
    percentileRank: Math.round(percentileRank * 10) / 10,
    top5fastest:    fastestRes.rows,
    nearest5:       nearestRes.rows,
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
