CREATE TABLE IF NOT EXISTS station_distances (
  start_station_id TEXT NOT NULL,
  end_station_id   TEXT NOT NULL,
  distance_meters  INTEGER NOT NULL,
  PRIMARY KEY (start_station_id, end_station_id)
);
