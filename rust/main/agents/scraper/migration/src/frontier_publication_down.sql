SET LOCAL lock_timeout='5s';

CREATE TEMP TABLE frontier_down_view_grant ON COMMIT DROP AS
SELECT c.relname,a.grantee,a.privilege_type,a.is_grantable
FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
WHERE c.relname IN ('confirmed_raw_message_dispatch','confirmed_delivered_message',
  'confirmed_gas_payment','confirmed_merkle_tree_insertion','message_view','total_gas_payment');
CREATE TEMP TABLE frontier_down_view_definition ON COMMIT DROP AS
SELECT c.relname,pg_get_viewdef(c.oid,true) AS definition FROM pg_class c
WHERE c.relname IN ('message_view','total_gas_payment');

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['raw_message_dispatch','delivered_message','gas_payment','merkle_tree_insertion'] LOOP
    EXECUTE format('DROP TRIGGER scraper_event_notify ON %I',relation);
  END LOOP;
END $$;
DROP TRIGGER gas_payment_stream_cursor_assign ON gas_payment;
DROP VIEW message_view,total_gas_payment;
DROP VIEW confirmed_raw_message_dispatch,confirmed_delivered_message,
  confirmed_gas_payment,confirmed_merkle_tree_insertion;

ALTER TABLE raw_message_dispatch ADD COLUMN confirmed boolean NOT NULL DEFAULT true;
ALTER TABLE delivered_message ADD COLUMN confirmed boolean NOT NULL DEFAULT true;
ALTER TABLE gas_payment ADD COLUMN confirmed boolean NOT NULL DEFAULT true;
ALTER TABLE merkle_tree_insertion ADD COLUMN confirmed boolean NOT NULL DEFAULT true;
UPDATE raw_message_dispatch SET confirmed=false WHERE id=ANY(ARRAY(
  SELECT pending.id FROM scraper_head h CROSS JOIN LATERAL (
    SELECT id FROM raw_message_dispatch p WHERE p.origin_domain=h.domain AND p.origin_block_height>h.confirmed_height
  ) pending
));
UPDATE delivered_message SET confirmed=false WHERE id=ANY(ARRAY(
  SELECT pending.id FROM scraper_head h CROSS JOIN LATERAL (
    SELECT id FROM delivered_message p WHERE p.domain=h.domain AND p.block_number>h.confirmed_height
  ) pending
));
UPDATE gas_payment SET confirmed=false WHERE id=ANY(ARRAY(
  SELECT pending.id FROM scraper_head h CROSS JOIN LATERAL (
    SELECT id FROM gas_payment p WHERE p.domain=h.domain AND p.block_number>h.confirmed_height
  ) pending
));
UPDATE merkle_tree_insertion SET confirmed=false WHERE id=ANY(ARRAY(
  SELECT pending.id FROM scraper_head h CROSS JOIN LATERAL (
    SELECT id FROM merkle_tree_insertion p WHERE p.domain=h.domain AND p.block_number>h.confirmed_height
  ) pending
));

CREATE INDEX gas_payment_unconfirmed ON gas_payment(domain,block_number) WHERE NOT confirmed;
CREATE INDEX merkle_insertion_unconfirmed ON merkle_tree_insertion(domain,block_number) WHERE NOT confirmed;
CREATE INDEX delivery_unenriched ON delivered_message(domain,id) WHERE confirmed AND destination_tx_id IS NULL AND block_hash IS NOT NULL;
CREATE INDEX gas_payment_unenriched ON gas_payment(domain,id) WHERE confirmed AND tx_id IS NULL AND block_hash IS NOT NULL;
CREATE VIEW confirmed_raw_message_dispatch AS SELECT * FROM raw_message_dispatch WHERE confirmed;
CREATE VIEW confirmed_delivered_message AS SELECT * FROM delivered_message WHERE confirmed;
CREATE VIEW confirmed_gas_payment AS SELECT * FROM gas_payment WHERE confirmed;
CREATE VIEW confirmed_merkle_tree_insertion AS SELECT * FROM merkle_tree_insertion WHERE confirmed;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM frontier_down_view_definition LOOP
    EXECUTE format('CREATE VIEW %I AS %s',item.relname,item.definition);
  END LOOP;
  FOR item IN SELECT * FROM frontier_down_view_grant LOOP
    EXECUTE format('GRANT %s ON %I TO %s%s',item.privilege_type,item.relname,
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION notify_scraper_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.confirmed OR (TG_OP='UPDATE' AND OLD.confirmed) THEN RETURN NEW; END IF;
  PERFORM pg_notify('scraper_event',json_build_object('eventType',TG_ARGV[0],'id',NEW.id::text,
    'domain',((to_jsonb(NEW)->>TG_ARGV[1])::bigint & 4294967295))::text);
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION notify_scraper_provisional_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('scraper_event_provisional',json_build_object('eventType',TG_ARGV[0],
    'id',NEW.id::text,'domain',((to_jsonb(NEW)->>TG_ARGV[1])::bigint & 4294967295))::text);
  RETURN NEW;
END $$;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('raw_message_dispatch','dispatch','origin_domain'),('delivered_message','delivery','domain'),
    ('gas_payment','gas_payment','domain'),('merkle_tree_insertion','merkle_tree_insertion','domain')
  ) AS t(relation,event_type,domain_column) LOOP
    EXECUTE format('CREATE TRIGGER scraper_event_notify AFTER INSERT OR UPDATE OF confirmed ON %I FOR EACH ROW EXECUTE FUNCTION notify_scraper_event(%L,%L)',item.relation,item.event_type,item.domain_column);
    EXECUTE format('CREATE TRIGGER scraper_provisional_event_notify AFTER INSERT ON %I FOR EACH ROW WHEN (NOT NEW.confirmed) EXECUTE FUNCTION notify_scraper_provisional_event(%L,%L)',item.relation,item.event_type,item.domain_column);
  END LOOP;
END $$;

-- Restore migration 14's trigger behavior.
CREATE OR REPLACE FUNCTION notify_scraper_explorer_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce((to_jsonb(NEW)->>'confirmed')::boolean,true) THEN
    PERFORM pg_notify('scraper_explorer_event',json_build_object('messageId',encode(NEW.msg_id,'hex'))::text);
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION assign_gas_payment_stream_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assigned_cursor bigint;
BEGIN
  INSERT INTO gas_payment_stream_head(domain,interchain_gas_paymaster,legacy_max_id,last_cursor)
    VALUES(NEW.domain,NEW.interchain_gas_paymaster,0,0) ON CONFLICT DO NOTHING;
  UPDATE gas_payment_stream_head SET last_cursor=last_cursor+1
    WHERE domain=NEW.domain AND interchain_gas_paymaster=NEW.interchain_gas_paymaster
    RETURNING last_cursor INTO STRICT assigned_cursor;
  INSERT INTO gas_payment_stream_cursor(gas_payment_id,domain,interchain_gas_paymaster,stream_cursor)
    VALUES(NEW.id,NEW.domain,NEW.interchain_gas_paymaster,assigned_cursor);
  RETURN NEW;
END $$;
CREATE TRIGGER gas_payment_stream_cursor_assign AFTER INSERT ON gas_payment
 FOR EACH ROW WHEN (NEW.confirmed) EXECUTE FUNCTION assign_gas_payment_stream_cursor();
CREATE TRIGGER gas_payment_stream_cursor_confirm AFTER UPDATE OF confirmed ON gas_payment
 FOR EACH ROW WHEN (NEW.confirmed AND NOT OLD.confirmed) EXECUTE FUNCTION assign_gas_payment_stream_cursor();

-- Restore migration 14's payload. Without previousConfirmedHeight, the new
-- proxy ignores this channel and consumes the restored per-row notifications.
CREATE OR REPLACE FUNCTION notify_scraper_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE change_kind text;
BEGIN
  change_kind := CASE WHEN TG_OP='INSERT' THEN 'initialized'
    WHEN NEW.indexed_height<OLD.indexed_height THEN 'rollback'
    WHEN NEW.indexed_height IS DISTINCT FROM OLD.indexed_height
      OR NEW.head_height IS DISTINCT FROM OLD.head_height
      OR NEW.confirmed_height IS DISTINCT FROM OLD.confirmed_height THEN 'progress'
    ELSE 'status' END;
  PERFORM pg_notify('scraper_head',json_build_object(
    'kind',change_kind,'domain',(NEW.domain::bigint & 4294967295),
    'startHeight',NEW.start_height::text,'indexedHeight',NEW.indexed_height::text,
    'indexedHash',encode(NEW.indexed_hash,'hex'),'headHeight',NEW.head_height::text,
    'confirmedHeight',NEW.confirmed_height::text,
    'previousIndexedHeight',CASE WHEN TG_OP='UPDATE' THEN OLD.indexed_height::text END,
    'healthy',NEW.healthy,'halted',NEW.halted)::text);
  RETURN NEW;
END $$;

DROP FUNCTION assign_confirmed_gas_payment_cursors(integer,bigint,bigint);
DROP STATISTICS gas_payment_domain_paymaster_dependencies;
DROP INDEX IF EXISTS delivery_frontier_unenriched,gas_payment_frontier_unenriched,
  gas_payment_frontier_height;
ALTER TABLE scraper_head DROP COLUMN writer_lease_until,DROP COLUMN writer_id;
