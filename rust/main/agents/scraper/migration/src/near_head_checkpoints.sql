-- Keep temporary reorg checkpoints out of the permanent Explorer block table.
-- The table contains the current confirmed boundary and the sparse unconfirmed
-- suffix only, so advancing confirmation can prune it with one indexed delete.
SET LOCAL lock_timeout='5s';

CREATE TABLE scraper_checkpoint (
  domain integer NOT NULL REFERENCES domain(id),
  height bigint NOT NULL,
  hash bytea NOT NULL,
  timestamp timestamp without time zone NOT NULL,
  PRIMARY KEY(domain,height)
);

-- Every scraper deployment sharing this database must be stopped. This lock
-- makes the copy internally consistent, but cannot prevent an old writer from
-- resuming after commit; startup validation rejects incompatible later writes.
LOCK TABLE scraper_head IN EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM scraper_head
    WHERE updated_at>clock_timestamp()-interval '90 seconds'
  ) THEN
    RAISE EXCEPTION 'Near-head state was updated in the last 90 seconds; stop all scraper writers and wait before retrying';
  END IF;
END $$;

-- Preserve the live reorg window while the old scraper is stopped. Drive the
-- copy from the small head table so PostgreSQL uses block_domain_height_key.
INSERT INTO scraper_checkpoint(domain,height,hash,timestamp)
SELECT b.domain,b.height,b.hash,b.timestamp
FROM scraper_head h CROSS JOIN LATERAL (
  SELECT domain,height,hash,timestamp FROM block b
  WHERE b.domain=h.domain AND b.height>=h.confirmed_height
    AND b.height<=h.indexed_height
  OFFSET 0
) b
ON CONFLICT DO NOTHING;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM scraper_head h
    WHERE NOT EXISTS (
      SELECT 1 FROM scraper_checkpoint c
      WHERE c.domain=h.domain AND c.height=h.confirmed_height
    )
  ) THEN
    RAISE EXCEPTION 'Missing confirmed near-head checkpoint; stop all scraper writers sharing this database and repair the boundary';
  END IF;
  IF EXISTS (
    SELECT 1 FROM scraper_head h
    WHERE NOT EXISTS (
      SELECT 1 FROM scraper_checkpoint c
      WHERE c.domain=h.domain AND c.height=h.indexed_height
        AND c.hash=h.indexed_hash
    )
  ) THEN
    RAISE EXCEPTION 'Missing or mismatched indexed near-head checkpoint; stop all scraper writers sharing this database and repair the boundary';
  END IF;
END $$;

-- Give block writers all checkpoint operations without exposing internal
-- reorg checkpoints to block readers.
DO $$ DECLARE item record; BEGIN
  FOR item IN
    SELECT a.grantee,bool_or(a.is_grantable) AS is_grantable FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='block'::regclass
      AND a.privilege_type IN ('INSERT','UPDATE','DELETE')
    GROUP BY a.grantee
  LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON scraper_checkpoint TO %s%s',
      CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
      CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
