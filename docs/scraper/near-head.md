# Near-head scraper

[Architecture and local development](../../rust/main/agents/scraper/README.md).

## Runtime

- Index events and block headers, then wake dispatch/delivery/gas enrichment.
  Scan on startup and ingestion, with a 5-second fallback (`index.interval` overrides it).
- Parallel streams may fetch the same uncached receipt; transaction uniqueness
  prevents duplicate storage. Refresh notifications are best effort: a crash/link
  failure after storing a receipt can delay a dispatch refresh until confirmation.
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

## Operations

For legacy cutovers, finish the RPC/log completeness audit (step 1 below) before
migration; backfill gaps with the legacy writer first. After migration, keep writers
stopped until verification and seeding succeed. Never restart an old writer against
the migrated database.

Stop every scraper sharing the database, including other environments. Use matching
scraper/proxy/migration versions. For legacy migrations, wait 90 seconds after stopping.
Run `init-db` as `postgres`; finish index verification and ANALYZE before restarting.
Check advancing indexed/confirmed heights, chain errors, and consumer streams afterward.

Stop-writer checks (repeat for every environment and scraper role):

```bash
kubectl --context <cluster> -n <env> scale statefulset omniscient-scraper-hyperlane-agent-scraper3 --replicas=0
kubectl --context <cluster> -n <env> get pods | grep scraper3   # expect none
```

```sql
SELECT pid, application_name, state, query_start FROM pg_stat_activity
WHERE usename IN ('<scraper role>', ...);   -- expect no rows
```

### Checkpoint repair

In `psql`, run this before checkpoint migration. It skips databases without
`scraper_head`; otherwise the boundary check must return no rows:

```sql
SELECT to_regclass('scraper_head') IS NOT NULL AS has_scraper_head \gset
\if :has_scraper_head
SELECT h.domain,h.confirmed_height,h.indexed_height
FROM scraper_head h
WHERE NOT EXISTS (
  SELECT 1 FROM block b
  WHERE b.domain=h.domain AND b.height=h.confirmed_height
) OR NOT EXISTS (
  SELECT 1 FROM block b
  WHERE b.domain=h.domain AND b.height=h.indexed_height
    AND b.hash=h.indexed_hash
);
\endif
```

After migration, this must return no rows:

```sql
SELECT h.domain,h.confirmed_height,h.indexed_height
FROM scraper_head h
WHERE NOT EXISTS (
  SELECT 1 FROM scraper_checkpoint c
  WHERE c.domain=h.domain AND c.height=h.confirmed_height
) OR NOT EXISTS (
  SELECT 1 FROM scraper_checkpoint c
  WHERE c.domain=h.domain AND c.height=h.indexed_height
    AND c.hash=h.indexed_hash
) OR EXISTS (
  SELECT 1 FROM scraper_checkpoint c
  WHERE c.domain=h.domain AND c.height>h.indexed_height
);
```

If checkpoints disagree, keep all writers stopped. Verify the saved head against
RPC first. Only when `block` contains the full canonical retained range, repair
as `postgres` with `psql "$DATABASE_URL" -v domain=N -f repair.sql`:

```sql
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE scraper_head IN EXCLUSIVE MODE;
DELETE FROM scraper_checkpoint c
USING scraper_head h
WHERE c.domain=h.domain AND c.domain=:'domain'::integer;
INSERT INTO scraper_checkpoint(domain,height,hash,timestamp)
SELECT b.domain,b.height,b.hash,b.timestamp
FROM scraper_head h CROSS JOIN LATERAL (
  SELECT domain,height,hash,timestamp FROM block b
  WHERE b.domain=h.domain AND b.height>=h.confirmed_height
    AND b.height<=h.indexed_height
  OFFSET 0
) b
WHERE h.domain=:'domain'::integer;
COMMIT;
```

Rerun the post-migration check before restarting. Missing blocks or a mismatched
indexed hash require restore or a separately verified boundary, not this repair.

### Verified legacy cutover

Only for existing history without `scraper_head`. Empty domains need no seed.

1. Verify all four streams are complete through the same finalized height `H`,
   with no pending range/retry at or below it. Compare configured-contract RPC
   logs with stored occurrences; repair gaps before seeding. Dispatch/Merkle
   counts supplement this audit but cannot prove delivery/gas completeness.
2. Keep all writers stopped. `H` must be at least `index.from - 1`, at least every
   stored block/event height, and no greater than the lowest completed stream.
   The shared `cursor` stores the faster delivery/gas watermark; it is not proof.
   Audit any interval between the last event, cursor, and chosen `H`. Never skip
   missing history by choosing a newer boundary.
3. Record canonical hash/timestamp and configured mailbox/hook/paymaster. After
   migration, compare contract counts at `H` with the scoped database counts below.
4. Check overlap, seed under the per-domain advisory lock, verify readback against
   fresh RPC, then restart. Never overwrite existing head state.

Use the provider's 32-byte hash encoding:

| Protocol               | Height/hash                                                              | Required sequence checks                                              |
| ---------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Ethereum               | Canonical block number and RPC hash                                      | Contiguous dispatch nonce/Merkle leaf indexes through contract counts |
| Sealevel               | Existing finalized slot; base58-decode blockhash, then hex               | Dispatch/insertion maxima and account counts agree                    |
| Cosmos / Cosmos Native | Queryable height ≥1; Tendermint/Comet block ID hash                      | Every available contract count; delivery/gas log audit                |
| Starknet               | Confirmed block; felt hash padded to 32 bytes                            | Mailbox nonce/Merkle count; delivery/gas log audit                    |
| Radix                  | Committed state version encoded as 32-byte big-endian; Gateway caught up | All four component counts                                             |
| Aleo                   | Canonical height; provider-decoded native hash                           | All four program mapping counts                                       |
| Tron                   | Solidified block number and blockID                                      | Mailbox nonce/Merkle count; delivery/gas log audit                    |

If `block` already contains `H`, read its stored encoding and compare with fresh RPC:

```sql
SELECT domain,height,encode(hash,'hex') AS provider_block_hash,
       extract(epoch FROM timestamp)::bigint AS timestamp
FROM block
WHERE domain=:'domain'::integer AND height=:'height'::bigint;
```

Compare these counts with RPC at `H`, using the exact configured contract scopes.
Legacy NULL heights use the linked transaction's block in the same domain. If a row
has neither an event height nor that block link, stop and verify/backfill it against
RPC before comparing counts; an unknown height must not be treated as below `H`.

```sql
SELECT
  (SELECT count(*)
   FROM raw_message_dispatch
   WHERE origin_domain=:'domain'::integer
     AND origin_mailbox=decode(:'mailbox','hex')
     AND origin_block_height<=:'height'::bigint) AS dispatch_count,
  (SELECT count(*) FROM delivered_message e
   LEFT JOIN "transaction" t ON e.block_number IS NULL AND t.id=e.destination_tx_id
   LEFT JOIN block b ON b.id=t.block_id AND b.domain=e.domain
   WHERE e.domain=:'domain'::integer
     AND e.destination_mailbox=decode(:'mailbox','hex')
     AND coalesce(e.block_number,b.height)<=:'height'::bigint) AS delivery_count,
  (SELECT count(*) FROM gas_payment e
   LEFT JOIN "transaction" t ON e.block_number IS NULL AND t.id=e.tx_id
   LEFT JOIN block b ON b.id=t.block_id AND b.domain=e.domain
   WHERE e.domain=:'domain'::integer
     AND e.interchain_gas_paymaster=decode(:'paymaster','hex')
     AND coalesce(e.block_number,b.height)<=:'height'::bigint) AS gas_payment_count,
  (SELECT count(*)
   FROM merkle_tree_insertion
   WHERE domain=:'domain'::integer
     AND merkle_tree_hook=decode(:'hook','hex')
     AND block_number<=:'height'::bigint) AS insertion_count;
```

Run overlap checks outside a transaction. `saved_state` must be NULL and each max
NULL or ≤`H`. They establish non-overlap, not completeness. Legacy delivery/gas
rows may lack heights, so check `block_max` too. Keep the indexed `max()` form;
`EXISTS (... > H)` can scan full history when nothing matches.

```sql
SELECT
  (SELECT 1 FROM scraper_head WHERE domain=:'domain'::integer) AS saved_state,
  (SELECT max(height) FROM block WHERE domain=:'domain'::integer) AS block_max,
  (SELECT max(origin_block_height) FROM raw_message_dispatch WHERE origin_domain=:'domain'::integer) AS dispatch_max,
  (SELECT max(block_number) FROM merkle_tree_insertion WHERE domain=:'domain'::integer) AS merkle_max,
  (SELECT max(block_number) FROM delivered_message WHERE domain=:'domain'::integer) AS delivery_max,
  (SELECT max(block_number) FROM gas_payment WHERE domain=:'domain'::integer) AS gas_max;
```

Supply `domain`, `height`, Unix-second `timestamp`, and hex `block_hash`, `mailbox`,
`hook`, `paymaster` without `0x` via `psql -v name=value`. Unsigned domain IDs above
`2^31-1` are stored minus `2^32`. Keep all writers stopped; do not add table locks
to this seed on the shared database.

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

Compare readback with recorded inputs and fresh RPC at `H`. A changed hash requires
reverification before restart. Startup validates contracts/checkpoints and starts
unhealthy until it observes a canonical head. Check database headroom before catch-up.

Default-finality SQL readers use `confirmed_*` event views; raw tables include
provisional rows. `message_view` and `total_gas_payment` retain their interfaces.
For downgrade/index rules see the [migration guide](../../rust/main/agents/scraper/migration/README.md).
An AltVM already using near-head needs an operator-reviewed cursor handoff or
restore before returning to a legacy indexer.

`hyperlane_scraper_receipt_oldest_pending_seconds{chain,event_type}` samples
unlinked delivery/gas receipts at page boundaries, at most once per poll interval,
including full-page drains. It reads pending rows instead of assuming an empty
page means drained. Metrics have no separate polling loop.
