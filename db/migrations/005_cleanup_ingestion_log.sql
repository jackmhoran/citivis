-- Remove malformed year-only entries (2013–2019) that were logged when the
-- key format was wrong. They have 0 trip_count and block re-ingestion.
DELETE FROM ingestion_log WHERE month ~ '^\d{4}$';
