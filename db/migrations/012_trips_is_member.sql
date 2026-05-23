ALTER TABLE trips ADD COLUMN IF NOT EXISTS is_member boolean;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trips' AND column_name = 'member_casual'
  ) THEN
    UPDATE trips SET is_member = (member_casual IN ('member', 'Subscriber'))
      WHERE is_member IS NULL AND member_casual IS NOT NULL;
    ALTER TABLE trips DROP COLUMN member_casual;
  END IF;
END $$;
