ALTER TABLE scraper_head ADD COLUMN IF NOT EXISTS verified_height bigint;
ALTER TABLE scraper_head DROP CONSTRAINT IF EXISTS scraper_head_verified_height_check;
ALTER TABLE scraper_head ADD CONSTRAINT scraper_head_verified_height_check CHECK(
  verified_height IS NULL OR
  (verified_height>=confirmed_height AND verified_height<=indexed_height)
);
