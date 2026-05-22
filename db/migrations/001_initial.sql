CREATE TABLE IF NOT EXISTS stations (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat  DOUBLE PRECISION,
  lng  DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS trips (
  ride_id          TEXT PRIMARY KEY,
  started_at       TIMESTAMPTZ NOT NULL,
  duration_seconds INT NOT NULL,
  start_station_id TEXT REFERENCES stations(id),
  end_station_id   TEXT REFERENCES stations(id),
  member_casual    TEXT
);

CREATE INDEX IF NOT EXISTS idx_trips_route_duration
  ON trips (start_station_id, end_station_id, duration_seconds);

CREATE INDEX IF NOT EXISTS idx_trips_started_at
  ON trips (started_at);

CREATE TABLE IF NOT EXISTS ingestion_log (
  month        TEXT PRIMARY KEY,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trip_count   INT NOT NULL
);
