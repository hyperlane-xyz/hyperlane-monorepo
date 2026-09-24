-- Keep temporary reorg checkpoints out of the permanent Explorer block table.
-- The table contains the current confirmed boundary and the sparse unconfirmed
-- suffix only, so advancing confirmation can prune it with one indexed delete.
CREATE TABLE scraper_checkpoint (
  domain integer NOT NULL REFERENCES domain(id),
  height bigint NOT NULL,
  hash bytea NOT NULL,
  timestamp timestamp without time zone NOT NULL,
  PRIMARY KEY(domain,height)
);

-- Preserve the live reorg window across a rolling upgrade. The old scraper
-- stored these checkpoints in block; copying extra event blocks is harmless and
-- they disappear as confirmation advances.
INSERT INTO scraper_checkpoint(domain,height,hash,timestamp)
SELECT b.domain,b.height,b.hash,b.timestamp
FROM block b JOIN scraper_head h ON h.domain=b.domain
WHERE b.height>=h.confirmed_height AND b.height<=h.indexed_height
ON CONFLICT DO NOTHING;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM scraper_head h
    WHERE NOT EXISTS (
      SELECT 1 FROM scraper_checkpoint c
      WHERE c.domain=h.domain AND c.height=h.confirmed_height
    )
  ) THEN
    RAISE EXCEPTION 'Missing confirmed near-head checkpoint';
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
