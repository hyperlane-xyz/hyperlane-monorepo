SET LOCAL lock_timeout='5s';

-- Rehydrate the old scraper's sparse checkpoints before removing their
-- dedicated table. Event block rows already exist and conflicts are harmless.
INSERT INTO block(domain,height,hash,timestamp)
SELECT domain,height,hash,timestamp FROM scraper_checkpoint
ON CONFLICT DO NOTHING;

DROP TABLE scraper_checkpoint;
