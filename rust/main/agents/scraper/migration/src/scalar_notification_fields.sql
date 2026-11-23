-- Domain and height already have scalar columns. Reading them directly avoids
-- serializing the entire event (including large bytea message bodies) to JSONB.
-- CREATE OR REPLACE preserves function ownership, grants, and trigger bindings.
CREATE OR REPLACE FUNCTION notify_scraper_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_domain integer; event_height bigint;
BEGIN
  IF TG_TABLE_NAME='raw_message_dispatch' THEN
    event_domain := NEW.origin_domain;
    event_height := NEW.origin_block_height;
  ELSE
    event_domain := NEW.domain;
    event_height := NEW.block_number;
  END IF;
  IF event_height IS NOT NULL
     AND EXISTS (SELECT 1 FROM scraper_head h WHERE h.domain=event_domain)
  THEN RETURN NEW; END IF;
  PERFORM pg_notify('scraper_event',json_build_object('eventType',TG_ARGV[0],'id',NEW.id::text,
    'domain',(event_domain::bigint & 4294967295))::text);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION notify_scraper_explorer_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Enriched messages have no block_number/domain columns. They always publish;
  -- their reconciler has already established confirmation of the raw dispatch.
  IF TG_TABLE_NAME <> 'message' THEN
    IF NEW.block_number IS NOT NULL AND EXISTS (
      SELECT 1 FROM scraper_head h
      WHERE h.domain=NEW.domain
        AND (TG_OP='INSERT' OR NEW.block_number>h.confirmed_height)
    ) THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_notify('scraper_explorer_event',json_build_object('messageId',encode(NEW.msg_id,'hex'))::text);
  RETURN NEW;
END $$;
