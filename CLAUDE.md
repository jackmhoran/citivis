# Citivis

Hono/Node.js API serving Citibike trip data for NYC. PostgreSQL backend.

## Stack

- **Runtime**: Node.js (ESM), Hono framework
- **DB**: Aiven PostgreSQL (cloud) via `pg` pool (`lib/db.js`)
- **Routing**: `routes/stations.js` → `queries/stations.js`
- **Tests**: Vitest (`npm test`) — unit tests with mock pool, no live DB

## Database access

Production DB is on Aiven. Set `DATABASE_URL` to the Aiven Service URI before running any script:

```bash
export DATABASE_URL="postgres://avnadmin:<password>@<host>:<port>/defaultdb?sslmode=require"
npm start
```

`lib/db.js` strips `sslmode` from the URL and sets `ssl: { rejectUnauthorized: false }` explicitly — required because pg-connection-string v3 treats `sslmode=require` as `verify-full` and rejects Aiven's self-signed cert chain otherwise.

Local dev still works without `DATABASE_URL` set (falls back to `postgresql://localhost/citivis`, no SSL).

## npm scripts

```
npm start              # run server
npm run migrate        # run all SQL migrations in db/migrations/ (no tracking — reruns all)
npm run ingest         # ingest a specific month: npm run ingest -- 2024-03
npm run sync           # fetch S3 listing, ingest all missing periods
npm run build-route-stats  # one-time: populate route_stats from trips + station_distances
npm run trim-trips     # one-time: reduce trips to top 5 fastest per pair
npm test               # vitest unit tests
```

## Schema

### `stations`
~2,847 rows. id, name, lat, lng, borough, neighborhood.

### `trips`
~5.4M rows after trimming. **Top 5 fastest rides per route pair only.** ride_id, started_at, duration_seconds (smallint, max 32767), start/end station_id, is_member (boolean).
- No indexes beyond primary key — with max 5 rows per pair, heap scans are equivalent
- `idx_trips_route_duration` and `idx_trips_started_at` were both dropped
- Only valid rows stored: start ≠ end, duration_seconds > 0

### `route_stats`
1.53M rows. One row per directed station pair. Pre-computed aggregates:
- trip_count, member_pct, min_seconds, distance_meters
- p10, p20, p30, p40, p50, p60, p70, p80, p90, p100 (every 10%)
- Populated by `build-route-stats.js`, maintained by `lib/maintain-route-stats.js` after each sync

### `explore_pool`
121k rows. Routes with ≥50 trips. Has its own p10/p25/p50/p75/p90 percentiles and distance_meters. Powers `/explore` endpoint.

### `ingestion_log`
Tracks ingested months (NYC: `2024-03`, JC: `JC-2024-03`). No migration tracking — migrate.js reruns all files every time.

## Key architectural decisions

**Timeframe filtering was removed.** `/stats` and `/compare` endpoints no longer accept `?timeframe=year|month|day`. All stats are all-time from `route_stats`.

**Raw trips are intentionally sparse.** trips only holds the 5 fastest rides per pair — enough for "fastest rides" display. All aggregate stats (counts, percentiles) come from `route_stats`, not live trip aggregation.

**`station_distances` was dropped.** Distance data (OSRM bike routing) now lives in `route_stats.distance_meters` and `explore_pool.distance_meters`. New stations added in future syncs won't get distances automatically — run `apply-distances` periodically.

**Percentile rank in `/compare` is interpolated**, not computed from raw data. `interpolatePercentileRank()` in `queries/stations.js` linearly interpolates between stored deciles.

## DB size history / what was tried

Started at ~15 GB (raw trips). Hosted on Aiven (Hobbyist plan, 5 GB storage).

| Change | Savings |
|--------|---------|
| Dropped `station_distances` | ~400 MB |
| Trimmed trips to top 5 fastest per pair | ~8.5 GB |
| Dropped `idx_trips_started_at` | ~400 MB |
| Dropped `idx_trips_route_duration` | ~415 MB |
| Condensed route_stats from 20→10 percentile columns + dropped max_seconds | ~60 MB |
| Deleted same-station + zero/negative duration trips | small |
| Converted member_casual text → is_member boolean | small |
| Converted duration_seconds int → smallint | small |
| VACUUM FULL | reclaimed bloat |
| **Current total** | **~1.13 GB** |

Remaining levers if further reduction needed:
- Prune `route_stats` where `trip_count < 3` (~546k rows, ~35% of table)

## Ingest pipeline

After each month ingests, `lib/maintain-route-stats.js` is called automatically with the set of affected route pairs. It:
1. Upserts `route_stats` for those pairs (recomputes from current trips)
2. Trims `trips` for those pairs back to top 5 fastest

OSRM distance data is NOT updated automatically on new routes — manual step required.
