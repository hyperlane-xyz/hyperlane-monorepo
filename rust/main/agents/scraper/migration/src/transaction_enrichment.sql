SET LOCAL lock_timeout='5s';

-- Remove the trigger left by the earlier version of this unreleased migration.
DROP TRIGGER IF EXISTS transaction_dispatch_enriched ON "transaction";
DROP FUNCTION IF EXISTS notify_transaction_dispatch_enriched();

-- Near-head writers update block state; transaction rows themselves are insert-only.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT a.grantee,a.is_grantable FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='block'::regclass AND a.privilege_type='UPDATE'
  LOOP
    EXECUTE format('GRANT DELETE ON "transaction" TO %s%s',
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
