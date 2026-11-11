# Near-head scraper

[Architecture and local development](../../rust/main/agents/scraper/README.md).

## Runtime

- Index events and block headers, then enrich dispatch/delivery/gas transactions.
- Confirm only complete, canonical history after `reorgPeriod`.
- The proxy enforces default or requested confirmation depths; metadata availability
  never establishes confirmation.
- Reorgs atomically delete provisional events, transaction links, transactions, and
  blocks. Stale in-flight writes fail foreign-key checks. Reorgs past confirmed
  history halt the chain.

`scraper_head` stores observed/indexed/confirmed heights; `scraper_checkpoint`
stores rollback anchors. Restarts resume these saved boundaries.

## Configuration

Use `chainsToScrape` and each chain's `index.from`, `index.chunk`, and
`index.interval` (default 5 seconds). Empty domains initialize automatically;
existing history without head state requires the cutover below.

RPCs must support event ranges, block lookup, latest height, and the configured
finality selector. EVM also needs hash-pinned `eth_call` and predeployment
`eth_getCode`. Incomplete ranges remain provisional and retry.

## Optional EVM WebSocket wake-ups

`websocketUrls` maps configured EVM chain names to WebSocket URLs. Logs wake HTTP
indexing; headers advance eligible confirmations. Polling remains the fallback.
For deployments, `websocketConfigSecret` loads the map through `CONFIG_FILES`.

## Rollout

Run [init-db](../../rust/main/agents/scraper/migration/README.md) before startup.
For legacy migrations, stop every writer sharing the database, wait at least
90 seconds, and use matching migration/scraper/proxy binaries. Check that
`indexed_height` and `confirmed_height` advance and the chain error metric clears.
Use confirmed views for default-finality SQL reads; raw event tables include
provisional rows.

### Verified legacy cutover

Only for domains with history but no `scraper_head` state:

1. Stop all writers sharing the database, including other environments.
2. Verify all four event streams are complete through the same finalized height
   `H`. Compare RPC logs and available contract counts with stored history. A
   shared cursor or latest event is insufficient. `H` must cover every stored
   block/event and be at least `index.from - 1`.
3. Record the canonical hash/timestamp at `H` and configured contract addresses.
   Use the Hyperlane provider's hash encoding, not an explorer display string.
4. Run the guarded seed below, verify its readback against RPC, then restart.
   Never overwrite existing head state or move a boundary to hide missing history.

Pass `domain`, `height`, Unix-second `timestamp`, and hex `block_hash`, `mailbox`,
`hook`, `paymaster` (without `0x`) via `psql -v name=value`. Domain IDs above
`2^31-1` use their signed database representation. Keep writers stopped and use
only the per-domain advisory lock; no table locks.

```sql
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE verified_cutover (
  domain integer NOT NULL,
  height bigint NOT NULL CHECK (height BETWEEN 0 AND 4294967294),
  timestamp bigint NOT NULL CHECK (timestamp >= 0),
  hash bytea NOT NULL CHECK (octet_length(hash) = 32),
  mailbox bytea NOT NULL CHECK (octet_length(mailbox) IN (20,32)),
  hook bytea NOT NULL CHECK (octet_length(hook) IN (20,32)),
  paymaster bytea NOT NULL CHECK (octet_length(paymaster) IN (20,32))
) ON COMMIT DROP;
INSERT INTO verified_cutover VALUES (
  :'domain'::integer, :'height'::bigint, :'timestamp'::bigint,
  decode(:'block_hash','hex'), decode(:'mailbox','hex'),
  decode(:'hook','hex'), decode(:'paymaster','hex')
);
SELECT pg_advisory_xact_lock(domain::bigint & 4294967295)
FROM verified_cutover;
DO $$
DECLARE c verified_cutover%ROWTYPE;
BEGIN
  SELECT * INTO STRICT c FROM verified_cutover;
  IF EXISTS (SELECT 1 FROM scraper_head WHERE domain=c.domain) THEN
    RAISE EXCEPTION 'Saved near-head state already exists; do not reseed it';
  END IF;
  IF EXISTS (SELECT 1 FROM scraper_checkpoint WHERE domain=c.domain)
    OR (SELECT max(height) FROM block WHERE domain=c.domain)>c.height
    OR (SELECT max(origin_block_height) FROM raw_message_dispatch
        WHERE origin_domain=c.domain)>c.height
  THEN
    RAISE EXCEPTION 'History overlaps the cutover; rerun the overlap checks';
  END IF;
  IF EXISTS (SELECT 1 FROM block WHERE domain=c.domain
             AND height=c.height AND hash<>c.hash)
    OR EXISTS (SELECT 1 FROM block WHERE hash=c.hash
               AND (domain<>c.domain OR height<>c.height))
  THEN
    RAISE EXCEPTION 'Cutover hash disagrees with stored block identity';
  END IF;
  INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,
                          head_height,confirmed_height,mailbox,
                          merkle_tree_hook,interchain_gas_paymaster)
    VALUES(c.domain,c.height,c.height,c.hash,c.height,c.height,
           c.mailbox,c.hook,c.paymaster);
  INSERT INTO scraper_checkpoint(domain,height,hash,timestamp)
    VALUES(c.domain,c.height,c.hash,to_timestamp(c.timestamp) AT TIME ZONE 'UTC');
  INSERT INTO block(domain,height,hash,timestamp)
    VALUES(c.domain,c.height,c.hash,to_timestamp(c.timestamp) AT TIME ZONE 'UTC')
    ON CONFLICT(hash) DO NOTHING;
END $$;
COMMIT;
SELECT domain,start_height,encode(indexed_hash,'hex') AS block_hash,
       encode(mailbox,'hex') AS mailbox,encode(merkle_tree_hook,'hex') AS hook,
       encode(interchain_gas_paymaster,'hex') AS paymaster,healthy
FROM scraper_head WHERE domain=:'domain'::integer;
```

Startup rechecks contracts and saved boundaries. If checkpoint/hash validation
fails, keep writers stopped and verify the canonical boundary before repair.
For downgrade/index compatibility, follow the [migration guide](../../rust/main/agents/scraper/migration/README.md).
