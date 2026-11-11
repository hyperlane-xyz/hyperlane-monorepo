SET LOCAL lock_timeout='5s';

-- Existing transaction writers also need to remove provisional fork metadata.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT a.grantee,a.is_grantable FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='transaction'::regclass AND a.privilege_type='UPDATE'
  LOOP
    EXECUTE format('GRANT DELETE ON "transaction" TO %s%s',
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;

-- Refresh all dispatches sharing a newly stored receipt, regardless of which
-- event worker fetched it. The block range uses raw_dispatch_block_height;
-- notifications commit atomically with the metadata, without rescanning history.
CREATE FUNCTION notify_transaction_dispatch_enriched() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('scraper_explorer_event',
    json_build_object('messageId',encode(e.msg_id,'hex'))::text)
  FROM block b CROSS JOIN LATERAL (
    SELECT msg_id FROM raw_message_dispatch
    WHERE origin_domain=b.domain AND origin_block_height=b.height
      AND origin_block_hash=b.hash AND origin_tx_hash=NEW.hash
    OFFSET 0
  ) e
  WHERE b.id=NEW.block_id;
  RETURN NEW;
END $$;
CREATE TRIGGER transaction_dispatch_enriched AFTER INSERT ON "transaction"
FOR EACH ROW EXECUTE FUNCTION notify_transaction_dispatch_enriched();
