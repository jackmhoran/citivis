import { describe, test, expect, vi, beforeEach } from 'vitest';
import { getClosestStations, getRandomStation, getMaxDate, getRouteStats, getRouteCompare, getExploreRoutes, getExploreMeta } from '../../queries/stations.js';

const mockPool = { query: vi.fn() };

beforeEach(() => mockPool.query.mockReset());

const START = 'station-A';
const END   = 'station-B';
const DATE_REF = new Date('2024-01-31T23:59:59Z');

const FAST_ROW    = { ride_id: 'fast-1', duration_seconds: 60,   started_at: '2024-01-15T08:30:00Z' };
const SLOW_ROW    = { ride_id: 'slow-1', duration_seconds: 3600, started_at: '2024-01-20T17:00:00Z' };
const PCT_ROW     = { p5:100,p10:120,p15:140,p20:160,p25:180,p30:200,p35:220,p40:240,p45:260,p50:280,p55:300,p60:320,p65:340,p70:360,p75:380,p80:400,p85:420,p90:440,p95:460,p100:600 };
const START_STATION = { id: START, name: 'Start Ave & 1 St', lat: 40.748, lng: -73.985 };
const END_STATION   = { id: END,   name: 'End Blvd & 2 St',  lat: 40.750, lng: -73.990 };

// ─── getClosestStations ───────────────────────────────────────────────────────

describe('getClosestStations', () => {
  const NEARBY = [
    { id: 's1', name: 'Near Station',  lat: 40.748, lng: -73.985, distance_meters: 42 },
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

// ─── getMaxDate ───────────────────────────────────────────────────────────────

describe('getMaxDate', () => {
  test('returns max date from query result', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ max_date: DATE_REF }] });
    const result = await getMaxDate(mockPool, START, END);
    expect(result).toBe(DATE_REF);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('MAX(started_at)'),
      [START, END]
    );
  });

  test('returns null when no trips exist for route', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ max_date: null }] });
    const result = await getMaxDate(mockPool, START, END);
    expect(result).toBeNull();
  });
});

// ─── getRouteStats ────────────────────────────────────────────────────────────

function mockStats(countVal = 100) {
  mockPool.query
    .mockResolvedValueOnce({ rows: [{ count: countVal }] })   // count
    .mockResolvedValueOnce({ rows: [FAST_ROW] })              // top10fastest
    .mockResolvedValueOnce({ rows: [SLOW_ROW] })              // top10slowest
    .mockResolvedValueOnce({ rows: [PCT_ROW] })               // percentiles
    .mockResolvedValueOnce({ rows: [START_STATION] })         // startStation
    .mockResolvedValueOnce({ rows: [END_STATION] });          // endStation
}

describe('getRouteStats', () => {
  test('alltime — returns correct structure and values', async () => {
    mockStats();
    const result = await getRouteStats(mockPool, START, END, null, 'alltime');

    expect(result.startStation).toEqual(START_STATION);
    expect(result.endStation).toEqual(END_STATION);
    expect(result.count).toBe(100);
    expect(result.top10fastest).toEqual([FAST_ROW]);
    expect(result.top10slowest).toEqual([SLOW_ROW]);
    expect(result.percentiles.p5).toBe(100);
    expect(result.percentiles.p50).toBe(280);
    expect(result.percentiles.p100).toBe(600);
  });

  test('alltime — passes only [startId, endId] params to trip queries', async () => {
    mockStats();
    await getRouteStats(mockPool, START, END, null, 'alltime');
    // first 4 calls are trip queries; last 2 are single-id station lookups
    for (const [, params] of mockPool.query.mock.calls.slice(0, 4)) {
      expect(params).toEqual([START, END]);
    }
  });

  test('year — appends dateRef as $3 to trip queries', async () => {
    mockStats();
    await getRouteStats(mockPool, START, END, DATE_REF, 'year');
    for (const [sql, params] of mockPool.query.mock.calls.slice(0, 4)) {
      expect(params).toEqual([START, END, DATE_REF]);
      expect(sql).toContain("DATE_TRUNC('year'");
    }
  });

  test('month — uses month truncation', async () => {
    mockStats();
    await getRouteStats(mockPool, START, END, DATE_REF, 'month');
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain("DATE_TRUNC('month'");
  });

  test('day — uses day truncation', async () => {
    mockStats();
    await getRouteStats(mockPool, START, END, DATE_REF, 'day');
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain("DATE_TRUNC('day'");
  });

  test('zero rows — returns 0 count, empty arrays, null percentiles', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [START_STATION] })
      .mockResolvedValueOnce({ rows: [END_STATION] });

    const result = await getRouteStats(mockPool, START, END, null, 'alltime');

    expect(result.count).toBe(0);
    expect(result.top10fastest).toEqual([]);
    expect(result.top10slowest).toEqual([]);
    expect(result.percentiles.p5).toBeNull();
    expect(result.percentiles.p100).toBeNull();
  });

  test('throws on invalid timeframe', async () => {
    await expect(getRouteStats(mockPool, START, END, null, 'invalid')).rejects.toThrow('Invalid timeframe');
  });
});

// ─── getRouteCompare ──────────────────────────────────────────────────────────

const DURATION = 300;
const NEAR_ROW = { ride_id: 'near-1', duration_seconds: 305 };

function mockCompare(countVal = 50) {
  mockPool.query
    .mockResolvedValueOnce({ rows: [{ count: countVal }] })           // count
    .mockResolvedValueOnce({ rows: [{ percentile_rank: '42.5' }] })   // percentileRank
    .mockResolvedValueOnce({ rows: [FAST_ROW] })                       // top5fastest
    .mockResolvedValueOnce({ rows: [SLOW_ROW] })                       // top5slowest
    .mockResolvedValueOnce({ rows: [NEAR_ROW] });                      // nearest10
}

describe('getRouteCompare', () => {
  test('alltime — returns correct structure and values', async () => {
    mockCompare();
    const result = await getRouteCompare(mockPool, START, END, DURATION, null, 'alltime');

    expect(result.count).toBe(50);
    expect(result.percentileRank).toBe(42.5);
    expect(result.top5fastest).toEqual([FAST_ROW]);
    expect(result.top5slowest).toEqual([SLOW_ROW]);
    expect(result.nearest10).toEqual([NEAR_ROW]);
  });

  test('alltime — duration is $3 in percentile_rank and nearest queries', async () => {
    mockCompare();
    await getRouteCompare(mockPool, START, END, DURATION, null, 'alltime');
    const calls = mockPool.query.mock.calls;

    // pctRank query (index 1) and nearest query (index 4) get duration appended
    expect(calls[1][1]).toEqual([START, END, DURATION]);
    expect(calls[4][1]).toEqual([START, END, DURATION]);
    // count, fastest, slowest get only base params
    expect(calls[0][1]).toEqual([START, END]);
    expect(calls[2][1]).toEqual([START, END]);
    expect(calls[3][1]).toEqual([START, END]);
  });

  test('year — duration is $4 when dateRef occupies $3', async () => {
    mockCompare();
    await getRouteCompare(mockPool, START, END, DURATION, DATE_REF, 'year');
    const calls = mockPool.query.mock.calls;

    expect(calls[0][1]).toEqual([START, END, DATE_REF]);          // count — base only
    expect(calls[1][1]).toEqual([START, END, DATE_REF, DURATION]); // pctRank
    expect(calls[4][1]).toEqual([START, END, DATE_REF, DURATION]); // nearest
    expect(calls[1][0]).toContain('$4');                           // duration at $4
  });

  test('zero rows — percentileRank is 0, arrays are empty', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ percentile_rank: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getRouteCompare(mockPool, START, END, DURATION, null, 'alltime');

    expect(result.count).toBe(0);
    expect(result.percentileRank).toBe(0);
    expect(result.nearest10).toEqual([]);
  });

  test('throws on invalid timeframe', async () => {
    await expect(getRouteCompare(mockPool, START, END, DURATION, null, 'bad')).rejects.toThrow('Invalid timeframe');
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
    // WHERE clause should have no borough/neighborhood conditions when unfiltered
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
