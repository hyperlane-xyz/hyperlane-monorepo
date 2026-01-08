# CCTP Availability Fix: Raw Message Index

**Status:** Draft
**Author:** @danilhl
**Created:** 2025-12-22

## Overview

**Goal:** Ensure CCTP message delivery works reliably even when Scraper experiences RPC provider failures.

**Approach:** Create a `raw_message_dispatch` table that stores message data using zero RPC calls, containing only event log data. CCTP switches to query this table instead of `message_view`.

**Result:** CCTP achieves 99.9%+ availability by eliminating dependency on RPC provider reliability.

---

## Problem Statement

### Current CCTP Dependency Chain

CCTP service requires transaction hashes to fetch receipts and extract CCTP MessageSent events:

```
User sends USDC cross-chain
  ↓
Hyperlane dispatches message
  ↓
Scraper indexes dispatch event
  → Requires RPC call to fetch block data
  → Requires RPC call to fetch transaction data
  ↓
Scraper stores message in database
  ↓
CCTP queries message_view for tx_hash
  ↓
CCTP fetches receipt and extracts MessageSent
  ↓
User's USDC transfer completes
```

### Failure Mode

When Scraper fails to fetch block or transaction data from RPC providers:

1. Message dispatch event detected from logs ✅
2. RPC call to fetch transaction fails ❌ (network timeout, rate limit, provider bug)
3. Message cannot be stored (FK constraint violation)
4. Scraper advances watermark past the event
5. CCTP query for message returns empty
6. CCTP attestation request fails: "Message not found"
7. **User cannot complete their cross-chain USDC transfer**
8. **User stuck until manual intervention**

**Severity:** Production blocker - directly prevents user transactions from completing.

### Why This Happens

The root cause is that Scraper's database schema enforces referential integrity:

```sql
-- Message table requires valid transaction FK
FOREIGN KEY (origin_tx_id) REFERENCES transaction(id)

-- Transaction requires valid block FK
FOREIGN KEY (block_id) REFERENCES block(id)
```

If RPC fails to fetch transaction or block, the entire message cannot be stored.

---

## Proposed Solution

### Key Insight: Event Logs Contain Everything CCTP Needs

When Scraper receives a Dispatch event, the event log already contains:

**From LogMeta (event metadata):**
- ✅ `transaction_id` (H512) - The transaction hash CCTP needs!
- ✅ `block_hash` (H256)
- ✅ `block_number` (u64)

**From HyperlaneMessage (decoded event data):**
- ✅ All message fields (version, nonce, origin, sender, destination, recipient, body)
- ✅ Computed message ID from keccak256

**Crucially:** All of this data is available from the event log itself - **no RPC calls required**.

### Solution Architecture

Create a separate table that stores only the data CCTP needs, populated directly from event logs:

```
Event Log Received
  ↓
Extract LogMeta + HyperlaneMessage
  ↓
Store in raw_message_dispatch table (ALWAYS SUCCEEDS)
  ↓
CCTP queries raw_message_dispatch for tx_hash
  ↓
CCTP fetches receipt and extracts MessageSent
  ↓
User's USDC transfer completes ✅
```

**Parallel path:** Scraper continues trying to enrich messages with block/transaction data for other use cases, but CCTP is no longer blocked by this process.

### New Table: `raw_message_dispatch`

```sql
CREATE TABLE raw_message_dispatch (
    id BIGSERIAL PRIMARY KEY,

    -- Metadata
    time_created TIMESTAMP NOT NULL DEFAULT NOW(),

    -- Message identification
    msg_id BYTEA NOT NULL UNIQUE,

    -- What CCTP needs (from LogMeta - no RPC required!)
    origin_tx_hash BYTEA NOT NULL,
    origin_block_hash BYTEA NOT NULL,
    origin_block_height BIGINT UNSIGNED NOT NULL,

    -- Message fields (for debugging)
    nonce INT UNSIGNED NOT NULL,
    origin_domain INT UNSIGNED NOT NULL,
    destination_domain INT UNSIGNED NOT NULL,
    sender BYTEA NOT NULL,
    recipient BYTEA NOT NULL,
    origin_mailbox BYTEA NOT NULL
);

-- Indexes
CREATE INDEX raw_message_dispatch_msg_id_idx ON raw_message_dispatch USING HASH (msg_id);
CREATE INDEX raw_message_dispatch_origin_domain_idx ON raw_message_dispatch USING BTREE (origin_domain);
CREATE INDEX raw_message_dispatch_destination_domain_idx ON raw_message_dispatch USING BTREE (destination_domain);
CREATE INDEX raw_message_dispatch_origin_tx_hash_idx ON raw_message_dispatch USING HASH (origin_tx_hash);
```

**Key insight:** All fields come from `LogMeta` (transaction hash, block hash, block height) and `HyperlaneMessage` (message fields) - **no RPC calls required**.

---

## Implementation

### Phase 1: Add Raw Message Storage (Scraper)

**File:** `rust/main/agents/scraper/src/db/raw_message_dispatch.rs`

```rust
/// Store raw message dispatches - ALWAYS succeeds (no RPC dependency)
pub async fn store_raw_message_dispatches(
    &self,
    origin_mailbox: &H256,
    messages: impl Iterator<Item = StorableRawMessageDispatch<'_>>,
) -> Result<u64> {
    let origin_mailbox = address_to_bytes(origin_mailbox);

    let models: Vec<raw_message_dispatch::ActiveModel> = messages
        .map(|storable| raw_message_dispatch::ActiveModel {
            id: NotSet,
            time_created: Set(date_time::now()),
            msg_id: Unchanged(h256_to_bytes(&storable.msg.id())),
            origin_tx_hash: Set(h512_to_bytes(&storable.meta.transaction_id)),
            origin_block_hash: Set(h256_to_bytes(&storable.meta.block_hash)),
            origin_block_height: Set(storable.meta.block_number as i64),
            nonce: Set(storable.msg.nonce as i32),
            origin_domain: Unchanged(storable.msg.origin as i32),
            destination_domain: Set(storable.msg.destination as i32),
            sender: Set(address_to_bytes(&storable.msg.sender)),
            recipient: Set(address_to_bytes(&storable.msg.recipient)),
            origin_mailbox: Unchanged(origin_mailbox.clone()),
        })
        .collect_vec();

    // Insert with chunking and transaction support...
    Ok(models.len() as u64)
}
```

**File:** `rust/main/agents/scraper/src/chain_scraper/mod.rs`

Update message indexing to store raw messages first:

```rust
async fn index_dispatched_messages(&self, range: RangeInclusive<u32>) -> Result<()> {
    let logs = self.indexer.fetch_logs_in_range(range).await?;

    let messages: Vec<(HyperlaneMessage, LogMeta)> = logs
        .into_iter()
        .filter_map(|(log, meta)| {
            self.indexer.parse_message(&log).ok().map(|msg| (msg, meta))
        })
        .collect();

    // FIRST: Store raw messages (always succeeds, no RPC)
    self.db.store_raw_message_dispatches(messages.clone()).await?;

    // SECOND: Try to enrich with block/transaction data
    // If this fails, raw messages are already stored
    match self.fetch_and_store_enriched_messages(messages).await {
        Ok(_) => info!("Stored enriched messages successfully"),
        Err(e) => warn!("Failed to store enriched messages, but raw messages saved: {}", e),
    }

    Ok(())
}
```

### Phase 2: Track Table in Hasura

Once the `raw_message_dispatch` table is created in PostgreSQL, Hasura needs to track it and expose it via GraphQL.

**Option 1: Hasura Console (manual)**
1. Open Hasura Console
2. Go to Data → Schema → public
3. Click "Track" next to `raw_message_dispatch` table
4. Configure permissions for CCTP service role

**Option 2: Hasura Metadata (automated)**

Add to Hasura metadata YAML:

```yaml
- table:
    schema: public
    name: raw_message_dispatch
  select_permissions:
  - role: cctp_service
    permission:
      columns:
      - msg_id
      - origin_tx_hash
      - origin_block_hash
      - origin_block_height
      - nonce
      - origin_domain
      - destination_domain
      - sender
      - recipient
      - origin_mailbox
      filter: {}
```

Hasura will automatically generate GraphQL queries like:

```graphql
query GetRawMessages($ids: [bytea!]!) {
  raw_message_dispatch(where: {msg_id: {_in: $ids}}) {
    msg_id
    origin_tx_hash
    origin_block_hash
    origin_block_height
    nonce
    origin_domain
    destination_domain
    sender
    recipient
    origin_mailbox
  }
}
```

### Phase 3: Update CCTP Service

**File:** `typescript/infra/src/cctp/read.ts` (or wherever CCTP queries Hasura)

Replace `message_view` query with `raw_message_dispatch` query:

```typescript
// OLD: Query message_view
const query = `
  query GetMessages($messageIds: [String!]!) {
    message_view(where: {msg_id: {_in: $messageIds}}) {
      msg_id
      origin_tx_hash
    }
  }
`;

// NEW: Query raw_message_dispatch
const query = `
  query GetMessages($messageIds: [String!]!) {
    raw_message_dispatch(where: {msg_id: {_in: $messageIds}}) {
      msg_id
      origin_tx_hash
    }
  }
`;
```

**That's it!** CCTP now queries the raw table which always has data.

---

## Migration Strategy

### Step 1: Deploy Scraper Changes

1. Create `raw_message_dispatch` table via migration
2. Deploy Scraper code that writes to both tables
3. Monitor to ensure raw table is populated correctly
4. Verify zero RPC dependency (should never see errors)

### Step 2: Update CCTP Service

1. Deploy CCTP code that queries `raw_message_dispatch`
2. Run in shadow mode for 24 hours (query both tables, compare results)
3. Switch to production mode
4. Monitor CCTP success rate (should increase to 99.9%+)

### Step 3: Verify & Document

1. Verify CCTP no longer experiences "Message not found" errors
2. Document the new table for other services that may need it
3. Update runbooks

---

## Optional: Backfill Historical Data

Backfilling is **optional** - the raw message index works for all new messages from deployment time forward. Backfill is only needed if:
- You want consistency for querying historical messages
- CCTP needs to access old messages (unlikely - CCTP only queries recent messages)
- You want complete data for debugging/analytics

### Backfill Script

Backfill existing messages by joining `message`, `transaction`, and `block` tables:

```sql
-- Backfill raw_message_dispatch from existing data
INSERT INTO raw_message_dispatch (
    msg_id,
    origin_tx_hash,
    origin_block_hash,
    origin_block_height,
    nonce,
    origin_domain,
    destination_domain,
    sender,
    recipient,
    origin_mailbox
)
SELECT
    m.msg_id,
    t.hash AS origin_tx_hash,
    b.hash AS origin_block_hash,
    b.height AS origin_block_height,
    m.nonce,
    m.origin AS origin_domain,
    m.destination AS destination_domain,
    m.sender,
    m.recipient,
    m.origin_mailbox
FROM message AS m
INNER JOIN transaction AS t ON m.origin_tx_id = t.id
INNER JOIN block AS b ON t.block_id = b.id
WHERE NOT EXISTS (
    -- Skip messages already in raw table
    SELECT 1 FROM raw_message_dispatch WHERE msg_id = m.msg_id
);
```

**Notes:**
- Uses `INNER JOIN` - only backfills messages where we have complete transaction and block data
- `WHERE NOT EXISTS` prevents duplicates if script is run multiple times
- Messages missing transaction/block data are skipped (accept gap for historical data)
- These are the messages that would have failed CCTP anyway, so no regression

**Verification query:**

```sql
-- Check backfill completeness
SELECT
    COUNT(*) AS total_messages,
    COUNT(DISTINCT r.msg_id) AS backfilled_count,
    COUNT(*) - COUNT(DISTINCT r.msg_id) AS missing_count
FROM message AS m
LEFT JOIN raw_message_dispatch AS r ON m.msg_id = r.msg_id;
```

**Expected result:** `missing_count` should equal the number of messages that were never properly indexed (due to past RPC failures).

---

## Testing Plan

### E2E Test

The `run-locally` test framework in `rust/main/utils/run-locally/` already includes Scraper integration with PostgreSQL database and metrics validation.

**Existing infrastructure (main.rs:231-303):**

```rust
// PostgreSQL database for Scraper
let postgres = AgentHandles::new(
    vec![docker(
        "scraper-testnet-postgres",
        "-e POSTGRES_PASSWORD=47221c18c610 -p 5432:5432",
        "postgres:14",
    )],
    HashMap::new(),
);

// Scraper environment configuration
let scraper_env = common_agent_env
    .bin(concat_path(AGENT_BIN_PATH, "scraper"))
    .hyp_env("DB", "postgresql://postgres:47221c18c610@localhost:5432/postgres")
    .hyp_env("CHAINSTOSCRAPE", "test1,test2,test3")
    .hyp_env("METRICSPORT", SCRAPER_METRICS_PORT);

// Scraper spawned as agent
state.push_agent(scraper_env.spawn("SCR", None));
```

**Existing validation (termination_invariants.rs:230):**

```rust
// Verifies Scraper indexed expected message count
pub fn scraper_termination_invariants_met(
    params: ScraperTerminationInvariantParams,
) -> eyre::Result<bool>
```

**Required test additions:**

1. **Add raw_message_dispatch table to init-db migration:**
   ```sql
   -- Add to rust/main/agents/scraper/migration/src/m20240711_000001_init.rs
   CREATE TABLE raw_message_dispatch (
       id BIGSERIAL PRIMARY KEY,
       msg_id BYTEA NOT NULL UNIQUE,
       origin_tx_hash BYTEA NOT NULL,
       -- ... full schema from Implementation section
   );
   ```

2. **Add metric validation to termination invariants:**
   ```rust
   // Verify raw table was populated
   let raw_dispatch_count = fetch_metric(
       SCRAPER_METRICS_PORT,
       "scraper_raw_message_dispatch_stored_total",
       &hashmap! {},
   )?;

   if raw_dispatch_count != total_messages_expected {
       log!("Raw message dispatch count mismatch: {} != {}",
            raw_dispatch_count, total_messages_expected);
       return Ok(false);
   }
   ```

3. **Add CCTP query simulation:**
   ```rust
   // Query raw table like CCTP would
   let conn = PgConnection::connect("postgresql://postgres:47221c18c610@localhost:5432/postgres")?;

   let query_result = sqlx::query!(
       "SELECT origin_tx_hash FROM raw_message_dispatch WHERE msg_id = $1",
       msg_id
   )
   .fetch_one(&conn)
   .await?;

   assert!(query_result.origin_tx_hash.is_some());
   ```

**Test execution:**

```bash
# Run E2E test from rust/main/
cargo run --release --bin run-locally

# Framework automatically:
# - Spins up 3 local EVM chains
# - Deploys Hyperlane contracts
# - Starts PostgreSQL container
# - Starts Scraper with test chains
# - Sends test messages
# - Validates raw_message_dispatch population
# - Validates CCTP query succeeds
```

---

## Monitoring & Alerts

### Metrics to Track

```rust
// Scraper metrics
pub static RAW_MESSAGE_STORE_SUCCESS: Lazy<IntCounter> =
    Lazy::new(|| register_int_counter!("scraper_raw_message_store_success", "Raw message store successes").unwrap());

pub static RAW_MESSAGE_STORE_FAILURE: Lazy<IntCounter> =
    Lazy::new(|| register_int_counter!("scraper_raw_message_store_failure", "Raw message store failures").unwrap());

// CCTP metrics
pub static CCTP_RAW_TABLE_QUERY_SUCCESS: Lazy<IntCounter> =
    Lazy::new(|| register_int_counter!("cctp_raw_table_query_success", "CCTP raw table query successes").unwrap());
```

### Grafana Dashboard Panels

1. **Raw Message Store Rate**
   - Query: `rate(scraper_raw_message_store_success[5m])`
   - Should match message dispatch rate
   - Alert if drops below dispatch rate

2. **CCTP Query Success Rate**
   - Query: `rate(cctp_raw_table_query_success[5m]) / rate(cctp_query_total[5m])`
   - Should be >99.9%
   - Alert if drops below 99%

3. **Raw Table Lag**
   - Query: `time() - max(time_created) FROM raw_message_dispatch`
   - Should be <10 seconds
   - Alert if >60 seconds

### Alerts

```yaml
- alert: RawMessageStoreFailing
  expr: rate(scraper_raw_message_store_failure[5m]) > 0
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Raw message storage is failing (should never happen)"

- alert: CCTPRawTableQueryFailing
  expr: rate(cctp_raw_table_query_success[5m]) / rate(cctp_query_total[5m]) < 0.99
  for: 10m
  labels:
    severity: high
  annotations:
    summary: "CCTP queries to raw_message_dispatch table failing"
```

---

## Rollback Plan

If something goes wrong during deployment:

### Phase 1 (Scraper writing to raw table)
**Rollback:**
1. Deploy previous Scraper version (stops writing to raw table)
2. Raw table remains but unused
3. CCTP continues using message_view

**Impact:** None - CCTP still broken on RPC failures (status quo)

### Phase 2 (CCTP reading from raw table)
**Rollback:**
1. Deploy previous CCTP version (uses message_view)
2. Raw table remains and continues being populated

**Impact:** CCTP back to original behavior (broken on RPC failures)

**Recovery:** Fix bug, redeploy CCTP to use raw table

---

## Security Considerations

### Threat: Malicious Event Logs

**Risk:** Attacker submits fake Dispatch events with valid signatures

**Mitigation:**
- Raw table stores exactly what's in event logs
- No additional trust assumptions beyond current system
- Validator signatures still required for message processing
- CCTP still verifies CCTP MessageSent event from receipt

**Conclusion:** No new attack surface

### Threat: Database Injection

**Risk:** SQL injection via msg_id or other fields

**Mitigation:**
- All fields are BYTEA or numeric types (not text)
- Parameterized queries used throughout
- msg_id is cryptographic hash (H256), not user input

**Conclusion:** Standard protections apply

### Threat: Data Poisoning

**Risk:** Corrupted raw_message_dispatch data breaks CCTP

**Mitigation:**
- Table is append-only (no UPDATEs)
- Each row has time_created timestamp for audit trail
- Can rebuild table from event logs if needed

**Conclusion:** Low risk, standard recovery available

---

## Next Steps

1. **Finish analysis** - Review and validate technical approach with team
2. **Create implementation tasks** - Break down work into actionable tickets
3. **Implement solution** - Execute Scraper, Hasura, and CCTP changes
