# Citivis

NYC Citibike trip stats API. Look up route stats, compare your ride time against historical data, and explore popular routes.

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js (ESM) |
| Framework | [Hono](https://hono.dev) + `@hono/node-server` |
| Database | PostgreSQL via `pg` |
| Testing | Vitest |

## Third-party integrations

| Service | Purpose |
|---------|---------|
| [Aiven](https://aiven.io) | Managed PostgreSQL hosting |
| [PostHog](https://posthog.com) | Product analytics + exception tracking |
| [OSRM](https://project-osrm.org) | Bike route distance/geometry (routing.openstreetmap.de) |
| [Railway](https://railway.app) | App hosting / deployment |
| Cloudflare | Reverse proxy (IP forwarding via `cf-connecting-ip`) |

## Environment variables

```bash
DATABASE_URL=postgres://avnadmin:<password>@<host>:<port>/defaultdb?sslmode=require
POSTHOG_API_KEY=...
POSTHOG_HOST=https://us.i.posthog.com   # or your region
OSRM_URL=https://routing.openstreetmap.de/routed-bike  # optional, this is the default
PORT=3000                                               # optional, default 3000
```

## Scripts

```bash
npm start                        # run server
npm test                         # vitest unit tests

npm run migrate                  # run all SQL migrations in db/migrations/
npm run ingest -- 2024-03        # ingest a specific month (NYC or JC-2024-03)
npm run sync                     # fetch S3 listing, ingest all missing months
npm run build-route-stats        # populate route_stats from trips + distances
npm run trim-trips               # keep only top 5 fastest rides per route pair
npm run apply-distances          # write OSRM distances into route_stats
npm run build-explore-pool       # rebuild explore_pool table (routes with ≥50 trips)
npm run fetch-explore-distances  # fetch OSRM distances for explore_pool rows
npm run verify                   # sanity-check data counts
```

## API

Base path: `/api/stations`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | All stations |
| GET | `/nearest?lat=&lng=` | Closest stations to a coordinate |
| GET | `/random` | Random station |
| GET | `/popular[?minFastest=<sec>]` | Popular routes, optionally filtered by min fastest time |
| GET | `/explore[?borough=&neighborhood=&minMedian=&sort=popular\|speed]` | Curated routes |
| GET | `/explore/meta` | Filter metadata for explore |
| GET | `/:id/destinations` | All destinations reachable from a station |
| GET | `/:startId/:endId/rides` | Raw ride records for a route |
| GET | `/:startId/:endId/stats` | Pre-computed aggregate stats for a route |
| GET | `/:startId/:endId/compare?duration=<sec>` | Percentile rank for a given ride time |

## Rate limiting

60 requests / IP / 60 seconds. Exceeded requests return `429` and are captured in PostHog.

## Data pipeline

1. **Ingest** — download monthly Citibike CSV from S3, parse, insert into `trips`
2. **Maintain** — after each ingest, `lib/maintain-route-stats.js` upserts `route_stats` for affected pairs and trims `trips` back to top 5 fastest per pair
3. **Distances** — run `apply-distances` periodically to backfill OSRM distances for new routes (not automatic)

See `CLAUDE.md` for full schema docs and DB size history.
