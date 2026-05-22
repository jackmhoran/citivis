CREATE TABLE IF NOT EXISTS explore_pool (
  id               SERIAL PRIMARY KEY,
  start_station_id TEXT NOT NULL REFERENCES stations(id),
  end_station_id   TEXT NOT NULL REFERENCES stations(id),
  trip_count       INT NOT NULL,
  min_seconds      INT NOT NULL,
  p10              INT NOT NULL,
  p25              INT NOT NULL,
  p50              INT NOT NULL,
  p75              INT NOT NULL,
  p90              INT NOT NULL
);
