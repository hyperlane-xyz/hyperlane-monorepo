-- Confirmation is represented only by scraper_head.confirmed_height. Preserve
-- grants while replacing views whose old shape included the transitional flag.
SET LOCAL lock_timeout='5s';

CREATE TEMP TABLE frontier_view_grant ON COMMIT DROP AS
SELECT c.relname,a.grantee,a.privilege_type,a.is_grantable
FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
WHERE c.relname IN ('confirmed_raw_message_dispatch','confirmed_delivered_message',
  'confirmed_gas_payment','confirmed_merkle_tree_insertion','message_view','total_gas_payment');
CREATE TEMP TABLE frontier_view_definition ON COMMIT DROP AS
SELECT c.relname,pg_get_viewdef(c.oid,true) AS definition FROM pg_class c
WHERE c.relname IN ('message_view','total_gas_payment');

DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['raw_message_dispatch','delivered_message','gas_payment','merkle_tree_insertion'] LOOP
    EXECUTE format('DROP TRIGGER scraper_event_notify ON %I',relation);
    EXECUTE format('DROP TRIGGER scraper_provisional_event_notify ON %I',relation);
  END LOOP;
END $$;
DROP TRIGGER gas_payment_stream_cursor_confirm ON gas_payment;
DROP TRIGGER gas_payment_stream_cursor_assign ON gas_payment;
DROP VIEW message_view,total_gas_payment;
DROP VIEW confirmed_raw_message_dispatch,confirmed_delivered_message,
  confirmed_gas_payment,confirmed_merkle_tree_insertion;

ALTER TABLE raw_message_dispatch DROP COLUMN confirmed;
ALTER TABLE delivered_message DROP COLUMN confirmed;
ALTER TABLE gas_payment DROP COLUMN confirmed;
ALTER TABLE merkle_tree_insertion DROP COLUMN confirmed;
DROP FUNCTION notify_scraper_provisional_event();

ALTER TABLE scraper_head ADD COLUMN writer_id text,
  ADD COLUMN writer_lease_until timestamptz;
CREATE STATISTICS gas_payment_domain_paymaster_dependencies (dependencies)
 ON domain,interchain_gas_paymaster FROM gas_payment;

CREATE VIEW confirmed_raw_message_dispatch AS
 SELECT e.* FROM raw_message_dispatch e
 WHERE e.origin_block_height<=COALESCE((SELECT h.confirmed_height FROM scraper_head h
   WHERE h.domain=e.origin_domain),9223372036854775807);
CREATE VIEW confirmed_delivered_message AS
 SELECT e.* FROM delivered_message e
 WHERE e.block_number IS NULL OR e.block_number<=COALESCE((SELECT h.confirmed_height
   FROM scraper_head h WHERE h.domain=e.domain),9223372036854775807);
CREATE VIEW confirmed_gas_payment AS
 SELECT e.* FROM gas_payment e
 WHERE e.block_number IS NULL OR e.block_number<=COALESCE((SELECT h.confirmed_height
   FROM scraper_head h WHERE h.domain=e.domain),9223372036854775807);
CREATE VIEW confirmed_merkle_tree_insertion AS
 SELECT e.* FROM merkle_tree_insertion e
 WHERE e.block_number<=COALESCE((SELECT h.confirmed_height FROM scraper_head h
   WHERE h.domain=e.domain),9223372036854775807);

DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM frontier_view_definition LOOP
    EXECUTE format('CREATE VIEW %I AS %s',item.relname,item.definition);
  END LOOP;
  FOR item IN SELECT * FROM frontier_view_grant LOOP
    EXECUTE format('GRANT %s ON %I TO %s%s',item.privilege_type,item.relname,
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;

-- Legacy domains have no scraper_head row and still publish on insert.
CREATE OR REPLACE FUNCTION notify_scraper_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM scraper_head h WHERE h.domain=(to_jsonb(NEW)->>TG_ARGV[1])::integer) THEN RETURN NEW; END IF;
  PERFORM pg_notify('scraper_event',json_build_object('eventType',TG_ARGV[0],'id',NEW.id::text,
    'domain',((to_jsonb(NEW)->>TG_ARGV[1])::bigint & 4294967295))::text);
  RETURN NEW;
END $$;
CREATE TRIGGER scraper_event_notify AFTER INSERT ON raw_message_dispatch
 FOR EACH ROW EXECUTE FUNCTION notify_scraper_event('dispatch','origin_domain');
CREATE TRIGGER scraper_event_notify AFTER INSERT ON delivered_message
 FOR EACH ROW EXECUTE FUNCTION notify_scraper_event('delivery','domain');
CREATE TRIGGER scraper_event_notify AFTER INSERT ON gas_payment
 FOR EACH ROW EXECUTE FUNCTION notify_scraper_event('gas_payment','domain');
CREATE TRIGGER scraper_event_notify AFTER INSERT ON merkle_tree_insertion
 FOR EACH ROW EXECUTE FUNCTION notify_scraper_event('merkle_tree_insertion','domain');

CREATE OR REPLACE FUNCTION notify_scraper_explorer_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM scraper_head h
    WHERE h.domain=(to_jsonb(NEW)->>'domain')::integer
      AND (TG_OP='INSERT' OR (to_jsonb(NEW)->>'block_number')::bigint>h.confirmed_height)
  ) THEN RETURN NEW; END IF;
  PERFORM pg_notify('scraper_explorer_event',json_build_object('messageId',encode(NEW.msg_id,'hex'))::text);
  RETURN NEW;
END $$;

-- Legacy inserts allocate immediately. Near-head rows allocate in a range just
-- before their frontier becomes visible.
CREATE OR REPLACE FUNCTION assign_gas_payment_stream_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assigned_cursor bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM scraper_head h WHERE h.domain=NEW.domain) THEN RETURN NEW; END IF;
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
 FOR EACH ROW EXECUTE FUNCTION assign_gas_payment_stream_cursor();

CREATE OR REPLACE FUNCTION assign_confirmed_gas_payment_cursors(
  target_domain integer, after_height bigint, through_height bigint
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE item record; assigned bigint := 0; first_cursor bigint;
BEGIN
  FOR item IN
    SELECT interchain_gas_paymaster,count(*)::bigint AS count FROM gas_payment g
    WHERE g.domain=target_domain AND g.block_number>after_height AND g.block_number<=through_height
      AND NOT EXISTS (SELECT 1 FROM gas_payment_stream_cursor c WHERE c.gas_payment_id=g.id)
    GROUP BY interchain_gas_paymaster ORDER BY interchain_gas_paymaster
  LOOP
    INSERT INTO gas_payment_stream_head(domain,interchain_gas_paymaster,legacy_max_id,last_cursor)
      VALUES(target_domain,item.interchain_gas_paymaster,0,0) ON CONFLICT DO NOTHING;
    UPDATE gas_payment_stream_head SET last_cursor=last_cursor+item.count
      WHERE domain=target_domain AND interchain_gas_paymaster=item.interchain_gas_paymaster
      RETURNING last_cursor-item.count+1 INTO STRICT first_cursor;
    INSERT INTO gas_payment_stream_cursor(gas_payment_id,domain,interchain_gas_paymaster,stream_cursor)
      SELECT g.id,g.domain,g.interchain_gas_paymaster,
        first_cursor+row_number() OVER (ORDER BY g.block_number,g.log_index,g.id)-1
      FROM gas_payment g
      WHERE g.domain=target_domain AND g.interchain_gas_paymaster=item.interchain_gas_paymaster
        AND g.block_number>after_height AND g.block_number<=through_height
        AND NOT EXISTS (SELECT 1 FROM gas_payment_stream_cursor c WHERE c.gas_payment_id=g.id)
      ORDER BY g.block_number,g.log_index,g.id;
    assigned := assigned+item.count;
  END LOOP;
  RETURN assigned;
END $$;

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
    'previousConfirmedHeight',CASE WHEN TG_OP='UPDATE' THEN OLD.confirmed_height::text END,
    'healthy',NEW.healthy,'halted',NEW.halted)::text);
  RETURN NEW;
END $$;

DO $$ DECLARE item record; BEGIN
  FOR item IN
    SELECT a.grantee,bool_or(a.is_grantable) AS is_grantable FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='gas_payment'::regclass AND a.privilege_type IN ('INSERT','UPDATE') GROUP BY a.grantee
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION assign_confirmed_gas_payment_cursors(integer,bigint,bigint) TO %s%s',
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
