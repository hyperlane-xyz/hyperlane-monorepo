-- Additive, disposable storage. No canonical table, trigger, sequence or view changes.
CREATE TABLE scraper_tip_head (
  domain integer PRIMARY KEY REFERENCES domain(id),
  revision bigint NOT NULL DEFAULT 0,
  epoch bigint NOT NULL DEFAULT 0,
  indexed_height bigint,
  indexed_hash bytea,
  from_height bigint,
  healthy boolean NOT NULL DEFAULT false,
  valid_until timestamptz NOT NULL DEFAULT now(),
  CHECK ((indexed_height IS NULL) = (indexed_hash IS NULL))
);
CREATE TABLE scraper_tip_event (
  domain integer NOT NULL REFERENCES scraper_tip_head(domain) ON DELETE CASCADE,
  block_number bigint NOT NULL,
  block_hash bytea NOT NULL,
  transaction_hash bytea NOT NULL,
  log_index bigint NOT NULL,
  message_id bytea NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY(domain,block_number,log_index)
);
CREATE INDEX scraper_tip_event_message ON scraper_tip_event(message_id);
-- Read one snapshot. epoch changes invalidate pagination on rollback; retention
-- can independently advance from_height. These are observations, never finality.
CREATE VIEW scraper_tip_visible AS
SELECT e.*,h.epoch,h.from_height,h.indexed_height
FROM scraper_tip_event e JOIN scraper_tip_head h USING(domain)
WHERE h.healthy AND h.valid_until>statement_timestamp();
