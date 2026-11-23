CREATE OR REPLACE FUNCTION notify_scraper_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)->>TG_ARGV[2]) IS NOT NULL
     AND EXISTS (SELECT 1 FROM scraper_head h WHERE h.domain=(to_jsonb(NEW)->>TG_ARGV[1])::integer)
  THEN RETURN NEW; END IF;
  PERFORM pg_notify('scraper_event',json_build_object('eventType',TG_ARGV[0],'id',NEW.id::text,
    'domain',((to_jsonb(NEW)->>TG_ARGV[1])::bigint & 4294967295))::text);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION notify_scraper_explorer_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)->>'block_number') IS NOT NULL AND EXISTS (
    SELECT 1 FROM scraper_head h
    WHERE h.domain=(to_jsonb(NEW)->>'domain')::integer
      AND (TG_OP='INSERT' OR (to_jsonb(NEW)->>'block_number')::bigint>h.confirmed_height)
  ) THEN RETURN NEW; END IF;
  PERFORM pg_notify('scraper_explorer_event',json_build_object('messageId',encode(NEW.msg_id,'hex'))::text);
  RETURN NEW;
END $$;
