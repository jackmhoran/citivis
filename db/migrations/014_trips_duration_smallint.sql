DELETE FROM trips WHERE duration_seconds <= 0;

UPDATE trips SET duration_seconds = 32767 WHERE duration_seconds > 32767;

ALTER TABLE trips ALTER COLUMN duration_seconds TYPE smallint;
