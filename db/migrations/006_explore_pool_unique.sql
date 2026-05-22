DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'explore_pool_route_unique'
  ) THEN
    ALTER TABLE explore_pool
      ADD CONSTRAINT explore_pool_route_unique UNIQUE (start_station_id, end_station_id);
  END IF;
END$$;
