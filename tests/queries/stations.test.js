import { describe, test, expect, vi, beforeEach } from 'vitest';
import { getClosestStations, getRandomStation, getRouteStats, getRouteCompare, getExploreRoutes, getExploreMeta } from '../../queries/stations.js';

const mockPool = { query: vi.fn() };

beforeEach(() => mockPool.query.mockReset());

const START = 'station-A';
const END   = 'station-B';

const FAST_ROW    = { ride_id: 'fast-1', duration_seconds: 60,   started_at: '2024-01-15T08:30:00Z' };
const SLOW_ROW    = { ride_id: 'slow-1', duration_seconds: 3600, started_at: '2024-01-20T17:00:00Z' };
const NEAR_ROW    = { ride_id: 'near-1', duration_seconds: 305 };
const PCT_ROW     = { p10:120,p20:160,p30:200,p40:240,p50:280,p60:320,p70:360,p80:400,p90:440,p100:600 };
const START_STATION = { id: START, name: 'Start Ave & 1 St', lat: 40.748, lng: -73.985 };
const END_STATION   = { id: END,   name: 'End Blvd & 2 St',  lat: 40.750, lng: -73.990 };
const STATS_ROW     = { trip_count: 100, member_pct: 75, distance_meters: 1200, min_seconds: 60, ...PCT_ROW };

// ─── getClosestStations ───────────────────────────────────────────────────────

describe('getClosestStations', () => {
  const NEARBY = [
    { id: 's1', name: 'Near Station',    lat: 40.748, lng: -73.985, distance_meters: 42 },
    { id: 's2', name: 'Further Station', lat: 40.750, lng: -73.990, distance_meters: 300 },
  ];

  test('returns stations ordered by distance', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: NEARBY });
    const result = await getClosestStations(mockPool, 40.748, -73.984);
    expect(result).toEqual(NEARBY);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT 10'),
      [40.748, -73.984]
    );
  });

  test('passes lat and lng as params (no interpolation)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getClosestStations(mockPool, 40.7, -73.9);
    expect(mockPool.query.mock.calls[0][1]).toEqual([40.7, -73.9]);
  });

  test('returns empty array when no stations have coords', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await getClosestStations(mockPool, 0, 0);
    expect(result).toEqual([]);
  });
});

// ─── getRandomStation ─────────────────────────────────────────────────────────

describe('getRandomStation', () => {
  const STATION = { id: 'abc', name: 'Central Park S & 6 Ave', lat: 40.765, lng: -73.976 };

  test('returns a station', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [STATION] });
    const result = await getRandomStation(mockPool);
    expect(result).toEqual(STATION);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('RANDOM()'));
  });

  test('returns null when stations table is empty', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await getRandomStation(mockPool);
    expect(result).toBeNull();
  });
});

// ─── getRouteStats ────────────────────────────────────────────────────────────
// Query order in Promise.all: [route_stats, fastest, slowest, startStation, endStation]

function mockStats(statsRow = STATS_ROW) {
  mockPool.query
    .mockResolvedValueOnce({ rows: [statsRow] })       // route_stats
    .mockResolvedValueOnce({ rows: [FAST_ROW] })       // top5fastest
    .mockResolvedValueOnce({ rows: [START_STATION] })  // startStation
    .mockResolvedValueOnce({ rows: [END_STATION] });   // endStation
}

describe('getRouteStats', () => {
  test('returns correct structure and values', async () => {
    mockStats();
    const result = await getRouteStats(mockPool, START, END);

    expect(result.startStation).toEqual(START_STATION);
    expect(result.endStation).toEqual(END_STATION);
    expect(result.count).toBe(100);
    expect(result.memberPct).toBe(75);
    expect(result.distanceMeters).toBe(1200);
    expect(result.top5fastest).toEqual([FAST_ROW]);
    expect(result.percentiles.p10).toBe(120);
    expect(result.percentiles.p50).toBe(280);
    expect(result.percentiles.p100).toBe(600);
  });

  test('trip queries use [startId, endId] params', async () => {
    mockStats();
    await getRouteStats(mockPool, START, END);
    const calls = mockPool.query.mock.calls;
    // route_stats + fastest both get both IDs
    for (const [, params] of calls.slice(0, 2)) {
      expect(params).toEqual([START, END]);
    }
    // station lookups get single IDs
    expect(calls[2][1]).toEqual([START]);
    expect(calls[3][1]).toEqual([END]);
  });

  test('route_stats query targets route_stats table', async () => {
    mockStats();
    await getRouteStats(mockPool, START, END);
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('route_stats');
    expect(sql).toContain('start_station_id = $1');
  });

  test('zero rows — returns 0 count, empty arrays, null percentiles', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })              // route_stats — no match
      .mockResolvedValueOnce({ rows: [] })              // fastest
      .mockResolvedValueOnce({ rows: [START_STATION] })
      .mockResolvedValueOnce({ rows: [END_STATION] });

    const result = await getRouteStats(mockPool, START, END);

    expect(result.count).toBe(0);
    expect(result.top5fastest).toEqual([]);
    expect(result.percentiles.p10).toBeNull();
    expect(result.percentiles.p100).toBeNull();
  });
});

// ─── getRouteCompare ──────────────────────────────────────────────────────────
// Query order in Promise.all: [route_stats, fastest, slowest, nearest]

const DURATION = 300;
const COMPARE_STATS = { trip_count: 50, min_seconds: 60, ...PCT_ROW };

function mockCompare(statsRow = COMPARE_STATS) {
  mockPool.query
    .mockResolvedValueOnce({ rows: [statsRow] })  // route_stats
    .mockResolvedValueOnce({ rows: [FAST_ROW] })  // top5fastest
    .mockResolvedValueOnce({ rows: [NEAR_ROW] }); // nearest5
}

describe('getRouteCompare', () => {
  test('returns correct structure', async () => {
    mockCompare();
    const result = await getRouteCompare(mockPool, START, END, DURATION);

    expect(result.count).toBe(50);
    expect(typeof result.percentileRank).toBe('number');
    expect(result.top5fastest).toEqual([FAST_ROW]);
    expect(result.nearest5).toEqual([NEAR_ROW]);
  });

  test('interpolates percentileRank from stored percentiles', async () => {
    // DURATION=300 == p55=300 in PCT_ROW → rank should be exactly 55
    mockCompare();
    const result = await getRouteCompare(mockPool, START, END, DURATION);
    expect(result.percentileRank).toBe(55);
  });

  test('duration faster than min_seconds → percentileRank 0', async () => {
    mockCompare({ ...COMPARE_STATS, min_seconds: 500 }); // duration=300 < min=500
    const result = await getRouteCompare(mockPool, START, END, DURATION);
    expect(result.percentileRank).toBe(0);
  });

  test('nearest query receives duration as $3', async () => {
    mockCompare();
    await getRouteCompare(mockPool, START, END, DURATION);
    const calls = mockPool.query.mock.calls;
    // nearest query (index 2) should have duration as third param
    expect(calls[2][1]).toEqual([START, END, DURATION]);
    expect(calls[2][0]).toContain('ABS(duration_seconds');
  });

  test('zero rows — percentileRank is 0, arrays are empty', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })  // route_stats — no match
      .mockResolvedValueOnce({ rows: [] })  // fastest
      .mockResolvedValueOnce({ rows: [] }); // nearest

    const result = await getRouteCompare(mockPool, START, END, DURATION);

    expect(result.count).toBe(0);
    expect(result.percentileRank).toBe(0);
    expect(result.nearest5).toEqual([]);
  });
});

// ─── getExploreRoutes ─────────────────────────────────────────────────────────

const EXPLORE_ROW = {
  startStationId: 'A', endStationId: 'B',
  startName: 'Ave A & 1 St', endName: 'Blvd B & 2 St',
  startBorough: 'Manhattan', startNeighborhood: 'East Village',
  endBorough: 'Brooklyn',    endNeighborhood: 'Williamsburg',
  startLat: '40.726', startLng: '-73.983', endLat: '40.713', endLng: '-73.957',
  tripCount: 120, minSeconds: 300, distanceMeters: 2400,
  p10: 360, p25: 420, p50: 540, p75: 720, p90: 900,
};

describe('getExploreRoutes', () => {
  test('no filters — uses default minMedian 300, no borough/neighborhood conditions', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [EXPLORE_ROW] });
    const result = await getExploreRoutes(mockPool);

    expect(result).toEqual([EXPLORE_ROW]);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(params).toEqual([300]);
    expect(sql).toContain('ep.p50 >= $1');
    expect(sql).toContain('ep.start_station_id != ep.end_station_id');
    expect(sql).toContain('ep.distance_meters');
    const whereClause = sql.slice(sql.indexOf('WHERE'));
    expect(whereClause).not.toContain('borough');
    expect(whereClause).not.toContain('neighborhood');
    expect(sql).toContain('ORDER BY ep.trip_count DESC');
  });

  test('sort=speed — orders by distance/p50 ratio', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getExploreRoutes(mockPool, { sort: 'speed' });

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('distance_meters');
    expect(sql).toContain('NULLIF(ep.p50, 0)');
    expect(sql).not.toContain('ep.trip_count DESC');
  });

  test('sort=popular — orders by trip_count (default)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getExploreRoutes(mockPool, { sort: 'popular' });

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('ep.trip_count DESC');
  });

  test('throws on invalid sort', async () => {
    await expect(getExploreRoutes(mockPool, { sort: 'weird' })).rejects.toThrow('Invalid sort');
  });

  test('borough filter — adds OR condition for s1/s2 borough', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getExploreRoutes(mockPool, { borough: 'Manhattan' });

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(params).toEqual([300, 'Manhattan']);
    expect(sql).toContain('s1.borough = $2 OR s2.borough = $2');
  });

  test('neighborhood filter — adds OR condition for s1/s2 neighborhood', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getExploreRoutes(mockPool, { borough: 'Brooklyn', neighborhood: 'Williamsburg' });

    const [sql, params] = mockPool.query.mock.calls[0];
    expect(params).toEqual([300, 'Brooklyn', 'Williamsburg']);
    expect(sql).toContain('s1.neighborhood = $3 OR s2.neighborhood = $3');
  });

  test('minMedian override — passes custom value as $1', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getExploreRoutes(mockPool, { minMedian: 600 });

    const [, params] = mockPool.query.mock.calls[0];
    expect(params[0]).toBe(600);
  });

  test('minMedian 0 — still passes 0 (not replaced by default)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getExploreRoutes(mockPool, { minMedian: 0 });

    const [, params] = mockPool.query.mock.calls[0];
    expect(params[0]).toBe(0);
  });

  test('returns empty array when no routes match', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await getExploreRoutes(mockPool);
    expect(result).toEqual([]);
  });
});

// ─── getExploreMeta ───────────────────────────────────────────────────────────

describe('getExploreMeta', () => {
  test('groups neighborhoods by borough', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [
      { borough: 'Manhattan',  neighborhood: 'Chelsea' },
      { borough: 'Manhattan',  neighborhood: 'Midtown' },
      { borough: 'Brooklyn',   neighborhood: 'Williamsburg' },
    ]});
    const result = await getExploreMeta(mockPool);

    expect(result).toEqual({
      Manhattan: ['Chelsea', 'Midtown'],
      Brooklyn:  ['Williamsburg'],
    });
  });

  test('skips null neighborhoods but keeps borough key', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [
      { borough: 'Queens', neighborhood: null },
      { borough: 'Queens', neighborhood: 'Astoria' },
    ]});
    const result = await getExploreMeta(mockPool);

    expect(result.Queens).toEqual(['Astoria']);
  });

  test('returns empty object when no geocoded stations in pool', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await getExploreMeta(mockPool);
    expect(result).toEqual({});
  });

  test('queries only stations that appear in explore_pool', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getExploreMeta(mockPool);

    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('explore_pool');
    expect(sql).toContain('borough IS NOT NULL');
  });
});
