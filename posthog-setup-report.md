<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into Citivis. A shared `lib/posthog.js` client was created and wired into both `server.js` and `routes/stations.js`. Seven events are now captured across the API, using the client IP as the distinct identifier. All events set `$process_person_profile: false` to avoid creating unnecessary person profiles for anonymous API callers. Unhandled exceptions and promise rejections are forwarded to PostHog's error tracking via `captureException`. The client shuts down cleanly on `SIGINT`/`SIGTERM` to flush any queued events before the process exits.

| Event | Description | File |
|---|---|---|
| `nearest_stations_searched` | User searched for Citibike stations nearest to a geographic coordinate | `routes/stations.js` |
| `popular_routes_viewed` | User browsed the most popular routes, optionally filtered by minimum fastest time | `routes/stations.js` |
| `route_explored` | User browsed routes via the explore endpoint, optionally filtered by borough, neighborhood, or sort order | `routes/stations.js` |
| `station_destinations_viewed` | User viewed all possible destinations from a given start station | `routes/stations.js` |
| `route_stats_viewed` | User looked up speed and count statistics for a specific route between two stations | `routes/stations.js` |
| `route_compared` | User compared their ride duration against historical data for a specific route — the core value action of the app | `routes/stations.js` |
| `rate_limit_exceeded` | A client exceeded the per-IP request rate limit (60 req/min) | `server.js` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics dashboard](https://us.posthog.com/project/454900/dashboard/1671471)
- [Key Events Over Time](https://us.posthog.com/project/454900/insights/3TPE3xiU) — daily trend of route comparisons, stats views, and explore sessions
- [Route Comparisons (Total)](https://us.posthog.com/project/454900/insights/BlqP7U1e) — KPI: total `route_compared` events in the last 30 days
- [User Discovery Journey](https://us.posthog.com/project/454900/insights/Ul2ItvVX) — multi-series view of the full station → route → compare flow
- [Explore Route Sessions](https://us.posthog.com/project/454900/insights/TMnhFBcI) — daily bar chart of explore endpoint usage
- [Rate Limit Events](https://us.posthog.com/project/454900/insights/HHLx3mCw) — bar chart of rate limit hits, useful for identifying abusive clients

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-javascript_node/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
