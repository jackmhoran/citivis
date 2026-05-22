import { Hono } from 'hono';
import pool from '../lib/db.js';
import { getAllStations, getStationDestinations, getClosestStations, getRandomStation, getMaxDate, getRouteStats, getRouteCompare, getPopularRoutes, getAllRouteRides, getExploreRoutes, getExploreMeta } from '../queries/stations.js';

const router = new Hono();

const VALID_TIMEFRAMES = new Set(['alltime', 'year', 'month', 'day']);

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
  return c.json({ routes });
});

router.get('/:id/destinations', async (c) => {
  const { id } = c.req.param();
  const destinations = await getStationDestinations(pool, id);
  return c.json({ destinations });
});

router.get('/:startId/:endId/rides', async (c) => {
  const { startId, endId } = c.req.param();
  const rides = await getAllRouteRides(pool, startId, endId);
  return c.json({ rides });
});

router.get('/:startId/:endId/stats', async (c) => {
  const { startId, endId } = c.req.param();
  const timeframe = c.req.query('timeframe') ?? 'alltime';

  if (!VALID_TIMEFRAMES.has(timeframe)) {
    return c.json({ error: `Invalid timeframe. Use: ${[...VALID_TIMEFRAMES].join(', ')}` }, 400);
  }

  const dateRef = timeframe === 'alltime' ? null : await getMaxDate(pool, startId, endId);
  const result = await getRouteStats(pool, startId, endId, dateRef, timeframe);
  return c.json(result);
});

router.get('/:startId/:endId/compare', async (c) => {
  const { startId, endId } = c.req.param();
  const timeframe = c.req.query('timeframe') ?? 'alltime';
  const durationStr = c.req.query('duration');

  if (!durationStr) return c.json({ error: 'duration query param is required' }, 400);
  const duration = parseInt(durationStr, 10);
  if (!Number.isInteger(duration) || duration <= 0) {
    return c.json({ error: 'duration must be a positive integer (seconds)' }, 400);
  }

  if (!VALID_TIMEFRAMES.has(timeframe)) {
    return c.json({ error: `Invalid timeframe. Use: ${[...VALID_TIMEFRAMES].join(', ')}` }, 400);
  }

  const dateRef = timeframe === 'alltime' ? null : await getMaxDate(pool, startId, endId);
  const result = await getRouteCompare(pool, startId, endId, duration, dateRef, timeframe);
  return c.json(result);
});

export default router;
