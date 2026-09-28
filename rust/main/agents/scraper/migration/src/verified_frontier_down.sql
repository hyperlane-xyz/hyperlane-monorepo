ALTER TABLE scraper_head DROP CONSTRAINT IF EXISTS scraper_head_verified_height_check,
  DROP COLUMN IF EXISTS verified_height;
