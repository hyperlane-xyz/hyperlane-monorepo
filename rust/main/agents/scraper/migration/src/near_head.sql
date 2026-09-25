-- Add metadata in place. Existing writers/rows remain confirmed by default;
-- existing uniqueness constraints, IDs, and transaction identities are preserved.
SET LOCAL lock_timeout = '5s';
ALTER TABLE raw_message_dispatch ADD COLUMN confirmed boolean NOT NULL DEFAULT true,
  ADD COLUMN log_index bigint, ADD COLUMN transaction_index bigint, ADD COLUMN message_version smallint;
ALTER TABLE delivered_message ADD COLUMN confirmed boolean NOT NULL DEFAULT true,
  ADD COLUMN block_hash bytea, ADD COLUMN block_number bigint,
  ADD COLUMN transaction_hash bytea, ADD COLUMN transaction_index bigint, ADD COLUMN log_index bigint;
ALTER TABLE gas_payment ADD COLUMN confirmed boolean NOT NULL DEFAULT true,
  ADD COLUMN block_hash bytea, ADD COLUMN block_number bigint,
  ADD COLUMN transaction_hash bytea, ADD COLUMN transaction_index bigint;
ALTER TABLE merkle_tree_insertion ADD COLUMN confirmed boolean NOT NULL DEFAULT true,
  ADD COLUMN block_hash bytea, ADD COLUMN transaction_hash bytea,
  ADD COLUMN transaction_index bigint, ADD COLUMN log_index bigint;
CREATE UNIQUE INDEX gas_payment_block_log ON gas_payment(domain,block_hash,coalesce(transaction_hash,'\x'::bytea),transaction_index,log_index,interchain_gas_paymaster,msg_id,destination,gas_amount,payment) WHERE block_hash IS NOT NULL;
CREATE INDEX raw_dispatch_block_height ON raw_message_dispatch(origin_domain,origin_block_height);
CREATE INDEX delivery_block_height ON delivered_message(domain,block_number);
CREATE INDEX gas_payment_unconfirmed ON gas_payment(domain,block_number) WHERE NOT confirmed;
CREATE INDEX merkle_insertion_unconfirmed ON merkle_tree_insertion(domain,block_number) WHERE NOT confirmed;
CREATE INDEX delivery_unenriched ON delivered_message(domain,id) WHERE confirmed AND destination_tx_id IS NULL AND block_hash IS NOT NULL;
CREATE INDEX gas_payment_unenriched ON gas_payment(domain,id) WHERE confirmed AND tx_id IS NULL AND block_hash IS NOT NULL;

CREATE TABLE scraper_head (
  domain integer PRIMARY KEY REFERENCES domain(id),
  start_height bigint NOT NULL,
  indexed_height bigint NOT NULL,
  indexed_hash bytea NOT NULL,
  head_height bigint NOT NULL,
  confirmed_height bigint NOT NULL,
  mailbox bytea NOT NULL,
  merkle_tree_hook bytea NOT NULL,
  interchain_gas_paymaster bytea NOT NULL,
  healthy boolean NOT NULL DEFAULT false,
  halted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(start_height>=0 AND confirmed_height>=start_height AND indexed_height>=confirmed_height),
  CHECK(head_height>=indexed_height)
);

CREATE VIEW confirmed_raw_message_dispatch AS SELECT * FROM raw_message_dispatch WHERE confirmed;
CREATE VIEW confirmed_delivered_message AS SELECT * FROM delivered_message WHERE confirmed;
CREATE VIEW confirmed_gas_payment AS SELECT * FROM gas_payment WHERE confirmed;
CREATE VIEW confirmed_merkle_tree_insertion AS SELECT * FROM merkle_tree_insertion WHERE confirmed;

-- Retain Explorer's existing output schema. Enriched messages are written only
-- after their raw dispatch is confirmed by the existing reconciler.
DO $$ DECLARE definition text; BEGIN
  SELECT pg_get_viewdef('message_view'::regclass,true) INTO definition;
  definition := regexp_replace(definition,'\mdelivered_message\M','confirmed_delivered_message','g');
  definition := regexp_replace(definition,'\mgas_payment\M','confirmed_gas_payment','g');
  EXECUTE 'CREATE OR REPLACE VIEW message_view AS ' || definition;
  SELECT pg_get_viewdef('total_gas_payment'::regclass,true) INTO definition;
  definition := replace(definition,'gas_payment gp','confirmed_gas_payment gp');
  EXECUTE 'CREATE OR REPLACE VIEW total_gas_payment AS ' || definition;
END $$;

CREATE OR REPLACE FUNCTION notify_scraper_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.confirmed THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.confirmed THEN RETURN NEW; END IF;
  PERFORM pg_notify('scraper_event',json_build_object('eventType',TG_ARGV[0],'id',NEW.id::text,
    'domain',((to_jsonb(NEW)->>TG_ARGV[1])::bigint & 4294967295))::text);
  RETURN NEW;
END $$;

-- Future custom-confirmation consumers need to see provisional inserts without
-- changing the confirmed-only channel consumed by the current proxy. Reorgs do
-- not emit one notification per deleted row; scraper_head publishes one atomic
-- rollback boundary instead.
CREATE OR REPLACE FUNCTION notify_scraper_provisional_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('scraper_event_provisional',json_build_object(
    'eventType',TG_ARGV[0],
    'id',NEW.id::text,
    'domain',((to_jsonb(NEW)->>TG_ARGV[1])::bigint & 4294967295)
  )::text);
  RETURN NEW;
END $$;

-- A head notification wakes delayed streams even when newly eligible blocks
-- contain no events. The indexed hash and previous boundary let a future proxy
-- validate durable cursors and reset a stream after a rollback.
CREATE OR REPLACE FUNCTION notify_scraper_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_kind text;
BEGIN
  change_kind := CASE
    WHEN TG_OP='INSERT' THEN 'initialized'
    WHEN NEW.indexed_height < OLD.indexed_height THEN 'rollback'
    WHEN NEW.indexed_height IS DISTINCT FROM OLD.indexed_height
      OR NEW.head_height IS DISTINCT FROM OLD.head_height
      OR NEW.confirmed_height IS DISTINCT FROM OLD.confirmed_height THEN 'progress'
    ELSE 'status'
  END;
  PERFORM pg_notify('scraper_head',json_build_object(
    'kind',change_kind,
    'domain',(NEW.domain::bigint & 4294967295),
    'startHeight',NEW.start_height::text,
    'indexedHeight',NEW.indexed_height::text,
    'indexedHash',encode(NEW.indexed_hash,'hex'),
    'headHeight',NEW.head_height::text,
    'confirmedHeight',NEW.confirmed_height::text,
    'previousIndexedHeight',CASE WHEN TG_OP='UPDATE' THEN OLD.indexed_height::text END,
    'healthy',NEW.healthy,
    'halted',NEW.halted
  )::text);
  RETURN NEW;
END $$;

CREATE TRIGGER scraper_head_insert_notify AFTER INSERT ON scraper_head
 FOR EACH ROW EXECUTE FUNCTION notify_scraper_head();
CREATE TRIGGER scraper_head_update_notify
 AFTER UPDATE OF indexed_height,indexed_hash,head_height,confirmed_height,healthy,halted ON scraper_head
 FOR EACH ROW WHEN (
   OLD.indexed_height IS DISTINCT FROM NEW.indexed_height
   OR OLD.indexed_hash IS DISTINCT FROM NEW.indexed_hash
   OR OLD.head_height IS DISTINCT FROM NEW.head_height
   OR OLD.confirmed_height IS DISTINCT FROM NEW.confirmed_height
   OR OLD.healthy IS DISTINCT FROM NEW.healthy
   OR OLD.halted IS DISTINCT FROM NEW.halted
 ) EXECUTE FUNCTION notify_scraper_head();

-- message has no provisional rows; gas and delivery do.
CREATE OR REPLACE FUNCTION notify_scraper_explorer_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce((to_jsonb(NEW)->>'confirmed')::boolean,true) THEN
    PERFORM pg_notify('scraper_explorer_event',json_build_object('messageId',encode(NEW.msg_id,'hex'))::text);
  END IF;
  RETURN NEW;
END $$;

-- Keep the existing cursor allocator, guarding it at the trigger instead. Only
-- the false -> true transition allocates a cursor; enrichment never allocates one.
DROP TRIGGER gas_payment_stream_cursor_assign ON gas_payment;
CREATE TRIGGER gas_payment_stream_cursor_assign AFTER INSERT ON gas_payment
 FOR EACH ROW WHEN (NEW.confirmed) EXECUTE FUNCTION assign_gas_payment_stream_cursor();
CREATE TRIGGER gas_payment_stream_cursor_confirm AFTER UPDATE OF confirmed ON gas_payment
 FOR EACH ROW WHEN (NEW.confirmed AND NOT OLD.confirmed) EXECUTE FUNCTION assign_gas_payment_stream_cursor();

DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('raw_message_dispatch','dispatch','origin_domain'),
    ('delivered_message','delivery','domain'),
    ('gas_payment','gas_payment','domain'),
    ('merkle_tree_insertion','merkle_tree_insertion','domain')
  ) AS t(relation,event_type,domain_column) LOOP
    EXECUTE format('DROP TRIGGER scraper_event_notify ON %I',item.relation);
    EXECUTE format('CREATE TRIGGER scraper_event_notify AFTER INSERT OR UPDATE OF confirmed ON %I FOR EACH ROW EXECUTE FUNCTION notify_scraper_event(%L,%L)',
      item.relation,item.event_type,item.domain_column);
    EXECUTE format('CREATE TRIGGER scraper_provisional_event_notify AFTER INSERT ON %I FOR EACH ROW WHEN (NOT NEW.confirmed) EXECUTE FUNCTION notify_scraper_provisional_event(%L,%L)',
      item.relation,item.event_type,item.domain_column);
  END LOOP;
  FOR item IN
    SELECT c.relname,a.grantee,a.is_grantable FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid IN ('raw_message_dispatch'::regclass,'delivered_message'::regclass,'gas_payment'::regclass,'merkle_tree_insertion'::regclass)
      AND a.privilege_type='SELECT'
  LOOP
    EXECUTE format('GRANT SELECT ON %I TO %s%s','confirmed_'||item.relname,
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  -- A custom-delay reader needs the canonical frontier in addition to event
  -- rows. Copy access from any event table instead of assuming the proxy uses
  -- the migration owner.
  FOR item IN
    SELECT a.grantee,bool_or(a.is_grantable) AS is_grantable FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid IN ('raw_message_dispatch'::regclass,'delivered_message'::regclass,'gas_payment'::regclass,'merkle_tree_insertion'::regclass)
      AND a.privilege_type='SELECT'
    GROUP BY a.grantee
  LOOP
    EXECUTE format('GRANT SELECT ON scraper_head TO %s%s',
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  -- Copy writer privileges from the existing tables. Near-head workers update
  -- their shared frontier and delete only unconfirmed fork rows or unreferenced
  -- headers. Reader roles must not receive these privileges.
  FOR item IN
    SELECT a.grantee,a.privilege_type,a.is_grantable FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='block'::regclass AND a.privilege_type IN ('INSERT','UPDATE')
  LOOP
    EXECUTE format('GRANT %s ON scraper_head TO %s%s',item.privilege_type,
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  FOR item IN
    SELECT c.relname,a.grantee,a.is_grantable FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid IN ('block'::regclass,'raw_message_dispatch'::regclass,
                    'delivered_message'::regclass,'gas_payment'::regclass,
                    'merkle_tree_insertion'::regclass)
      AND a.privilege_type='UPDATE'
  LOOP
    EXECUTE format('GRANT DELETE ON %I TO %s%s',item.relname,
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
