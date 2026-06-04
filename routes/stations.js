import { Hono } from 'hono';
import pool from '../lib/db.js';
import { getAllStations, getStationDestinations, getClosestStations, getRandomStation, getRouteStats, getRouteCompare, getPopularRoutes, getAllRouteRides, getExploreRoutes, getExploreMeta } from '../queries/stations.js';
import posthog from '../lib/posthog.js';

function getIp(c) {
  return c.req.header('cf-connecting-ip')
    ?? c.req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? 'unknown';
}

const router = new Hono();

router.get('/', async (c) => {
  const stations = await getAllStations(pool);
  return c.json({ stations });
});

router.get('/nearest', async (c) => {
  const lat = parseFloat(c.req.query('lat'));
  const lng = parseFloat(c.req.query('lng'));
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return c.json({ error: 'lat (-90–90) and lng (-180–180) are required' }, 400);
  }
  const stations = await getClosestStations(pool, lat, lng);
  posthog.capture({
    distinctId: getIp(c),
    event: 'nearest_stations_searched',
    properties: { lat, lng, result_count: stations.length, $process_person_profile: false },
  });
  return c.json({ stations });
});

router.get('/random', async (c) => {
  const station = await getRandomStation(pool);
  if (!station) return c.json({ error: 'No stations found' }, 404);
  return c.json(station);
});

router.get('/popular', async (c) => {
  const minFastestStr = c.req.query('minFastest');
  let minFastest = 0;
  if (minFastestStr !== undefined) {
    minFastest = parseInt(minFastestStr, 10);
    if (!Number.isInteger(minFastest) || minFastest < 0) {
      return c.json({ error: 'minFastest must be a non-negative integer (seconds)' }, 400);
    }
  }
  const routes = await getPopularRoutes(pool, minFastest);
  posthog.capture({
    distinctId: getIp(c),
    event: 'popular_routes_viewed',
    properties: { min_fastest: minFastest, result_count: routes.length, $process_person_profile: false },
  });
  return c.json({ routes });
});

router.get('/explore/meta', async (c) => {
  const meta = await getExploreMeta(pool);
  return c.json({ meta });
});

router.get('/explore', async (c) => {
  const borough      = c.req.query('borough')      || null;
  const neighborhood = c.req.query('neighborhood') || null;
  const minMedianStr = c.req.query('minMedian');
  const minMedian    = minMedianStr ? parseInt(minMedianStr, 10) : 300;
  if (isNaN(minMedian) || minMedian < 0)
    return c.json({ error: 'minMedian must be a non-negative integer (seconds)' }, 400);
  const sort = c.req.query('sort') ?? 'popular';
  if (!['popular', 'speed'].includes(sort))
    return c.json({ error: 'sort must be popular or speed' }, 400);
  const routes = await getExploreRoutes(pool, { borough, neighborhood, minMedian, sort });
  posthog.capture({
    distinctId: getIp(c),
    event: 'route_explored',
    properties: { borough, neighborhood, min_median: minMedian, sort, result_count: routes.length, $process_person_profile: false },
  });
  return c.json({ routes });
});

router.get('/:id/destinations', async (c) => {
  const { id } = c.req.param();
  const destinations = await getStationDestinations(pool, id);
  posthog.capture({
    distinctId: getIp(c),
    event: 'station_destinations_viewed',
    properties: { station_id: id, result_count: destinations.length, $process_person_profile: false },
  });
  return c.json({ destinations });
});

router.get('/:startId/:endId/rides', async (c) => {
  const { startId, endId } = c.req.param();
  const rides = await getAllRouteRides(pool, startId, endId);
  return c.json({ rides });
});

router.get('/:startId/:endId/stats', async (c) => {
  const { startId, endId } = c.req.param();
  const result = await getRouteStats(pool, startId, endId);
  posthog.capture({
    distinctId: getIp(c),
    event: 'route_stats_viewed',
    properties: {
      start_station_id: startId,
      end_station_id: endId,
      trip_count: result.count ?? 0,
      distance_meters: result.distanceMeters ?? null,
      $process_person_profile: false,
    },
  });
  return c.json(result);
});

router.get('/:startId/:endId/compare', async (c) => {
  const { startId, endId } = c.req.param();
  const durationStr = c.req.query('duration');

  if (!durationStr) return c.json({ error: 'duration query param is required' }, 400);
  const duration = parseInt(durationStr, 10);
  if (!Number.isInteger(duration) || duration <= 0) {
    return c.json({ error: 'duration must be a positive integer (seconds)' }, 400);
  }

  const result = await getRouteCompare(pool, startId, endId, duration);
  posthog.capture({
    distinctId: getIp(c),
    event: 'route_compared',
    properties: {
      start_station_id: startId,
      end_station_id: endId,
      duration_seconds: duration,
      percentile_rank: result.percentileRank,
      trip_count: result.count ?? 0,
      $process_person_profile: false,
    },
  });
  return c.json(result);
});

export default router;
