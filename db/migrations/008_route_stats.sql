CREATE TABLE IF NOT EXISTS route_stats (
  start_station_id TEXT NOT NULL REFERENCES stations(id),
  end_station_id   TEXT NOT NULL REFERENCES stations(id),
  trip_count       INT NOT NULL,
  member_pct       SMALLINT,
  min_seconds      INT NOT NULL,
  max_seconds      INT NOT NULL,
  distance_meters  INT,
  p5   INT, p10  INT, p15  INT, p20  INT,
  p25  INT, p30  INT, p35  INT, p40  INT,
  p45  INT, p50  INT, p55  INT, p60  INT,
  p65  INT, p70  INT, p75  INT, p80  INT,
  p85  INT, p90  INT, p95  INT, p100 INT,
  PRIMARY KEY (start_station_id, end_station_id)
);
