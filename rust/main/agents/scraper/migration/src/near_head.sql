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
CREATE UNIQUE INDEX gas_payment_block_log ON gas_payment(domain,block_hash,log_index);
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
END $$;
