# Fast Relay API Implementation Plan

## Executive Summary

**Problem**: Relayers wait 20-60 seconds in production (10-30s scraper + 10-30s relayer indexing) before starting to process messages. UI knows the tx_hash immediately after transaction confirms, but can't tell the relayer to "process this message now."

**Solution**: Add `POST /relay` endpoint where UI can submit tx_hash. Relayer extracts message from transaction receipt and injects directly into MessageProcessor, bypassing all indexing delays.

**Key Design Principles**:

- ✅ **General-purpose**: Works for ALL message types (warp routes, general messaging, any ISM)
- ✅ **Chain-agnostic**: EVM initially, extensible to Cosmos/Sealevel/etc.
- ✅ **ISM-agnostic**: Reuses existing ISM verification (MultisigISM, AggregationISM, etc.)
- ✅ **Additive**: Doesn't replace normal indexing, adds fast path for UI-initiated flows
- ✅ **Simple**: Minimal code changes, leverages existing MessageProcessor infrastructure

**Expected Performance**:

- Local (no scraper): **3-5s saved** (11.29s → 7-9s average)
- Production (with scraper): **20-60s saved** (29-78s → 6-15s average)
- Improvement: 27-85% faster depending on environment

## Current Slow Implementation - Complete Flow

```
┌─────────────────────────────────────────────────────────────┐
│ USER ACTION: Send Hyperlane message                        │
│ - UI calls contract (warp route, messaging, etc.)          │
│ - Transaction dispatches Hyperlane message                 │
│ - Mailbox emits Dispatch event                             │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ SCRAPER (Delay 1: 10-30 seconds)                           │
│ - Polls origin chain every 5-10 seconds                    │
│ - Indexes Mailbox.Dispatch event                           │
│ - Writes to Explorer PostgreSQL database                   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ EXPLORER DATABASE                                           │
│ - raw_message_dispatch table populated                     │
│ - GraphQL API becomes available                            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ RELAYER CONTRACT SYNC (Delay 2: 10-30 seconds)             │
│ - Polls origin chain independently                         │
│ - Indexes same Dispatch event again                        │
│ - Writes to local RocksDB                                  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ DB LOADER (Delay 3: 1 second)                              │
│ - Scans RocksDB every 1 second                            │
│ - Applies whitelist/blacklist filters                     │
│ - Sends to MessageProcessor                                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ MESSAGE PROCESSOR - PREPARE STAGE                          │
│ - Checks if already delivered                              │
│ - Validates recipient is contract                          │
│ - Builds ISM metadata (varies by ISM type):               │
│   * MultisigISM: Fetch validator signatures               │
│   * AggregationISM: Fetch multiple ISM metadatas          │
│   * RoutingISM: Determine route + fetch metadata          │
│   * TrustedRelayerISM: No metadata needed                 │
│ - Estimates gas for destination tx                        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ MESSAGE PROCESSOR - SUBMIT STAGE                           │
│ - Submits tx with ISM metadata to destination             │
│ - Mailbox.process() → ISM.verify() → handles message      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ MESSAGE PROCESSOR - CONFIRM STAGE (Delay 6: 10 minutes)   │
│ - Waits for finality period                               │
│ - Verifies tx inclusion post-reorg window                 │
└─────────────────────────────────────────────────────────────┘
                            ↓
                    Transfer Complete!

TOTAL DELAY BEFORE RELAY STARTS: 21-61 seconds
  - Scraper indexing: 10-30s
  - Relayer indexing: 10-30s
  - DB loader scan: 1s
```

## Identified Bottlenecks

### 1. **Duplicate Indexing (20-60s total)**

- Scraper indexes for Explorer (10-30s delay)
- Relayer indexes same events independently (10-30s delay)
- Both poll origin chain at different cadences
- Wasteful: Same event indexed twice before processing starts

### 2. **DB Write/Read Cycles (1s+)**

- Scraper writes to Explorer PostgreSQL
- Relayer writes to local RocksDB
- DbLoader reads from RocksDB every 1 second
- Multiple persistence layers slow message propagation

### 3. **No User-Initiated Fast Path**

- User knows tx_hash immediately after transaction confirms
- Could tell relayer "process this message now"
- Instead, relayer must discover it independently
- Wastes time re-discovering known information

---

## Fast Relay API - Proposed Architecture

**Key Insight**: UI knows tx_hash immediately. Why wait for indexers to discover it?

```
┌─────────────────────────────────────────────────────────────┐
│ USER ACTION: Send Hyperlane message                        │
│ - UI calls contract (warp route, messaging, etc.)          │
│ - Transaction mined on origin chain                        │
│ - UI receives transaction receipt                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ UI CALLS: POST /relay                                      │
│ Body: {                                                     │
│   origin_chain: "ethereum",                                │
│   tx_hash: "0x123..."                                      │
│ }                                                           │
│ Response: { job_id: "uuid-1234" }                         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ RELAY ENDPOINT (< 1 second)                               │
│                                                             │
│ 1. Validate request (rate limit check)                    │
│ 2. Fetch tx receipt from origin RPC (200-500ms)           │
│ 3. Extract Hyperlane Dispatch event from logs             │
│ 4. Parse HyperlaneMessage from event data                 │
│ 5. Create in-memory relay job                             │
│ 6. Return job_id immediately                              │
│                                                             │
│ ⚡ No scraper wait                                         │
│ ⚡ No explorer query                                       │
│ ⚡ No relayer indexing delay                              │
│ ⚡ Works for ALL message types                            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ ASYNC RELAY WORKER (runs in background)                   │
│                                                             │
│ 1. Create PendingMessage from extracted HyperlaneMessage  │
│ 2. Inject directly into MessageProcessor queue            │
│    - Bypasses DB entirely                                 │
│    - Bypasses DbLoader                                    │
│    - Bypasses ContractSync                                │
│                                                             │
│ 3. PREPARE STAGE (handled by MessageProcessor):           │
│    a) Check if already delivered                          │
│    b) Validate recipient is contract                      │
│    c) Build ISM metadata (MultisigISM, AggregationISM,    │
│       RoutingISM, TrustedRelayerISM, etc.)                │
│    d) Estimate gas                                        │
│    e) Update job status: "preparing"                      │
│                                                             │
│ 4. SUBMIT STAGE (handled by MessageProcessor):            │
│    a) Submit tx to destination Mailbox                    │
│    b) Update job status: "submitted"                      │
│    c) Store destination tx_hash in job                    │
│                                                             │
│ 5. CONFIRM STAGE (handled by MessageProcessor):           │
│    a) Wait for finality period                            │
│    b) Verify tx inclusion                                 │
│    c) Update job status: "confirmed"                      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ UI POLLS: GET /relay/:job_id                              │
│ Response: {                                                 │
│   status: "confirmed",                                     │
│   message_id: "0xabc...",                                 │
│   destination_tx_hash: "0xdef...",                        │
│   created_at: "2024-03-11T...",                           │
│   updated_at: "2024-03-11T..."                            │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
                            ↓
                    Relay Complete!

TOTAL DELAY BEFORE RELAY STARTS: < 1 second
  - RPC tx fetch: 0.2-0.5s
  - Event extraction: 0.1s
  - Queue injection: 0.01s

TIME SAVINGS: 20-60 seconds eliminated!
```

## Architecture Components

### 1. RelayJob (In-Memory Store)

```rust
pub struct RelayJob {
    pub id: Uuid,
    pub origin_chain: String,
    pub origin_tx_hash: H256,
    pub message_id: H256,
    pub destination_chain: String,
    pub status: RelayStatus,
    pub destination_tx_hash: Option<H256>,
    pub error: Option<String>,
    pub created_at: u64,  // Unix timestamp (seconds)
    pub updated_at: u64,
    pub expires_at: u64,  // TTL: 1 hour
}

pub enum RelayStatus {
    Pending,      // Job created, not started
    Extracting,   // Fetching tx receipt
    Preparing,    // MessageProcessor preparing (building ISM metadata)
    Submitting,   // Submitting to destination
    Submitted,    // Tx submitted, waiting confirmation
    Confirmed,    // Tx confirmed on destination
    Failed,       // Error occurred
}
```

### 2. Endpoint Handlers

**POST /relay**

```rust
async fn create_relay(
    State(state): State<ServerState>,
    Json(req): Json<RelayRequest>,
) -> ServerResult<RelayResponse> {
    // 1. Validate request (origin_chain, tx_hash format)
    // 2. Rate limit check
    // 3. Fetch tx receipt from origin chain RPC
    // 4. Extract Hyperlane Dispatch event from logs
    // 5. Parse HyperlaneMessage from event data
    // 6. Create RelayJob (status: Pending)
    // 7. Spawn async worker to inject into MessageProcessor
    // 8. Return job_id immediately
}
```

**GET /relay/:id**

```rust
async fn get_relay_status(
    State(state): State<ServerState>,
    Path(job_id): Path<Uuid>,
) -> ServerResult<RelayJob> {
    // Lookup job in in-memory store
    // Return current status
    // Return 404 if job expired/not found
}
```

### 3. Direct MessageProcessor Injection

**Flow:**

```rust
// Normal path:
ContractSync → RocksDB → DbLoader → channel → MessageProcessor

// Fast relay path:
POST /relay → extract message → channel → MessageProcessor

// Both use same MessageProcessor, same deduplication, same ISM verification!
```

**Key Benefits:**

- No new ISM logic needed - reuses all existing ISM implementations
- No special handling for MultisigISM, AggregationISM, RoutingISM, etc.
- MessageProcessor already handles all message types
- Deduplication prevents double-processing if both paths deliver same message

## Key Benefits

### Performance

- **20-60 seconds faster** in production (bypasses scraper + relayer indexing)
- **3-5 seconds faster** in local setup (bypasses DB loader delay)
- No waiting for duplicate indexing
- Direct RPC fetch from already-confirmed transaction

### Simplicity

- **No new ISM logic** - reuses all existing ISM implementations
- Works for **all message types** (warp routes, general messaging, any ISM)
- Works for **all chains** (EVM initially, extensible to Cosmos/Sealevel/etc.)
- **Additive** - doesn't replace normal indexing, just adds fast path

### Reliability

- Independent of scraper uptime
- Independent of explorer database availability
- Self-contained RPC fetching
- Falls back to normal indexing if fast relay fails
- Explicit error states via job status

### User Experience

- Immediate job_id response (<1s)
- Real-time status polling via GET /relay/:id
- Clear error messages when failures occur
- Predictable relay timing (no variable indexing delays)

## Implementation Status

### ✅ Completed Work

1. **Measurement Infrastructure**
   - Created `scripts/measure-relay-time.sh` - benchmarks relay times with statistics
   - Measured baseline: 11.29s average with 12s block time
   - Identified timing breakdown and bottlenecks

2. **Architecture Analysis**
   - Mapped complete message flow: ContractSync → DB Loader → MessageProcessor
   - Identified injection point: mpsc channel between DB Loader and MessageProcessor
   - Confirmed deduplication exists in MessageProcessor (by message_id)

### 🚧 Implementation Strategy

### Phase 1: Core Infrastructure

**Goal**: Create `/relay` API endpoints and job tracking

**Files to create:**

```
rust/main/agents/relayer/src/relay_api/
├── mod.rs              # Module exports
├── job.rs              # RelayJob struct + RelayStatus enum
├── store.rs            # JobStore (in-memory HashMap with RwLock)
├── worker.rs           # RelayWorker (spawns async tasks)
└── extractor.rs        # Message extraction from tx receipts
```

**Files to modify:**

- `rust/main/agents/relayer/src/lib.rs` - Add `pub mod relay_api;`
- `rust/main/agents/relayer/src/server/mod.rs` - Add relay routes
- `rust/main/agents/relayer/src/relayer.rs` - Pass message channels to server

**Tasks:**

1. Define `RelayJob` struct with status enum
2. Implement `JobStore` (in-memory HashMap with Arc<RwLock>)
3. Add job expiration/cleanup task (1 hour TTL)
4. Create `POST /relay` endpoint handler
5. Create `GET /relay/:id` endpoint handler
6. Add simple global rate limiter (100 req/min)

**Success Criteria:**

- Can create job via POST /relay
- Can query job status via GET /relay/:id
- Jobs expire after 1 hour
- Rate limiter rejects excessive requests

### Phase 2: Message Extraction (EVM Chains)

**Goal**: Extract HyperlaneMessage from EVM transaction receipts

**Approach:**

- Reuse existing `EthereumMailboxIndexer` for event parsing
- Chain-agnostic design (provider registry per chain)
- Extract Dispatch event → parse HyperlaneMessage

**Key Insight**: `EthereumMailboxIndexer::fetch_logs_by_tx_hash()` already does exactly what we need!

**Tasks:**

1. Create `ProviderRegistry` - maps chain name → Arc<Middleware>
2. Implement `extract_message_from_tx()`:
   - Fetch tx receipt via provider
   - Use EthereumMailboxIndexer to parse Dispatch event
   - Return HyperlaneMessage
3. Add error handling for:
   - Chain not found in registry
   - Transaction not found
   - No Dispatch event in transaction
4. Wire provider registry into ServerState

**Success Criteria:**

- Can extract HyperlaneMessage from any EVM tx_hash
- Returns clear errors for invalid inputs
- Works with local anvil chains (test with measurement script tx)

### Phase 3: MessageProcessor Injection

**Goal**: Inject extracted messages directly into MessageProcessor queue

**Key Files:**

- `relayer/src/msg/message_processor.rs` - The processor we're injecting into
- `relayer/src/msg/pending_message.rs` - Message lifecycle manager
- `relayer/src/relayer.rs` - Creates MessageProcessor + channels

**Approach:**

```rust
// MessageProcessor already receives messages via mpsc channel:
let (tx, rx) = mpsc::unbounded_channel::<QueueOperation>();

// QueueOperation is trait object containing PendingMessage
// We'll create our own QueueOperation and send via same channel!
```

**Tasks:**

1. Study `DbLoader` to understand how it creates PendingMessages
2. Create `RelayWorker` that:
   - Takes extracted HyperlaneMessage
   - Creates PendingMessage (same as DbLoader does)
   - Wraps in QueueOperation
   - Sends to MessageProcessor channel
3. Update RelayJob status based on PendingMessage callbacks:
   - Preparing → Submitting → Submitted → Confirmed
4. Handle MessageProcessor errors → RelayJob status: Failed

**Success Criteria:**

- Messages injected via API appear in MessageProcessor
- Status updates flow back to RelayJob
- Deduplication works (same message via API + indexer = processed once)

### Phase 4: End-to-End Integration

**Goal**: Complete flow from POST /relay to destination delivery

**Tasks:**

1. Wire all components together in server initialization
2. Add status update callbacks from PendingMessage to RelayJob
3. Test full flow:
   - Send warp transfer to local anvil
   - Call POST /relay with tx_hash
   - Poll GET /relay/:id until Confirmed
   - Verify destination balance updated
4. Compare timing against baseline (use measurement script)
5. Add logging for debugging

**Success Criteria:**

- End-to-end relay works via API
- Faster than normal indexing path (3-5s local, 20-60s production)
- Clear error states when failures occur
- Normal indexing path unaffected

### Phase 5: Multi-Chain Support (Future)

**Goal**: Extend beyond EVM to Cosmos, Sealevel, etc.

**Approach:**

- Abstract message extraction behind trait
- Per-chain extractor implementations
- Provider registry handles all chain types

**Deferred**: Start with EVM only, add other chains based on demand.

### Phase 6: Monitoring & Polish (Future)

1. Unit tests for endpoint handlers
2. Integration tests with mock chains
3. Prometheus metrics:
   - `relay_api_requests_total` (by chain, status code)
   - `relay_api_duration_seconds` (by phase: extract, inject, deliver)
   - `relay_api_jobs_total` (by status)
4. Structured logging with tracing
5. API documentation (OpenAPI spec)

## Critical Files

**New Files (to create):**

- `rust/main/agents/relayer/src/relay_api/mod.rs` - Module exports
- `rust/main/agents/relayer/src/relay_api/job.rs` - RelayJob struct + RelayStatus
- `rust/main/agents/relayer/src/relay_api/store.rs` - JobStore (in-memory store)
- `rust/main/agents/relayer/src/relay_api/worker.rs` - RelayWorker (injection logic)
- `rust/main/agents/relayer/src/relay_api/extractor.rs` - Message extraction

**Existing Files (to understand, minimal modifications):**

- `rust/main/agents/relayer/src/msg/message_processor.rs` - Target for injection (READ ONLY)
- `rust/main/agents/relayer/src/msg/pending_message.rs` - Message lifecycle (READ ONLY)
- `rust/main/agents/relayer/src/msg/db_loader.rs` - Reference for how to create PendingMessages
- `rust/main/hyperlane-ethereum/src/mailbox.rs` - EthereumMailboxIndexer for extraction

**Files to Modify:**

- `rust/main/agents/relayer/src/lib.rs` - Add `pub mod relay_api;`
- `rust/main/agents/relayer/src/server/mod.rs` - Add POST /relay and GET /relay/:id routes
- `rust/main/agents/relayer/src/relayer.rs` - Pass message channels to server

## Recommendations Based on Measurements

### 1. Start with EVM, Design for Multi-Chain

**Rationale**: Measured use case is EVM (local anvil). Most production traffic is EVM. But design should be extensible.

**Recommendation**:

- Phase 1-4: Implement for EVM chains only
- Use ProviderRegistry abstraction for multi-chain extensibility
- Add Cosmos/Sealevel extractors in Phase 5 when needed
- Benefit: Ship faster, validate with real usage, extend based on demand

### 2. Production Deployment Priority

**Rationale**: Local improvement (3-5s) is nice but modest. Production improvement (20-60s) is transformational.

**Recommendation**:

- Focus on production deployment where scraper delays dominate
- Local fast relay is a debugging tool
- Production fast relay is a UX game-changer

### 3. Monitoring is Critical

**Rationale**: Fast relay bypasses normal audit trail. Need visibility into what's happening.

**Recommendation**:

- Add structured logging from day 1
- Track job status transitions
- Monitor success/failure rates
- Alert on high failure rates

### 4. Start with Opt-In

**Rationale**: Fast relay is a new code path. Validate before making it default.

**Recommendation**:

- UI explicitly calls fast relay endpoint
- Normal relay continues in background as fallback
- Gradually increase fast relay usage based on success metrics
- Eventually: fast relay becomes default, normal indexing is backup

## Open Questions & Decisions

### 1. Should we write to DB for record-keeping?

**Options:**

- A) Skip DB write entirely (pure in-memory)
- B) Write to DB asynchronously after injection
- C) Write to DB before injection (adds latency)

**Analysis:**

- Normal indexing will write to DB anyway (within ~1-30s)
- Fast relay job store provides short-term audit trail
- Writing adds latency and complexity

**Recommendation**: **Option A** - Skip DB write, rely on normal indexing for persistence. Keep fast relay jobs in memory for 1 hour for status polling.

### 2. Rate limiting strategy?

**Options:**

- A) No rate limiting (trust relayer operator to secure endpoint)
- B) Global rate limit (100 req/min total)
- C) Per-IP rate limit (100 req/min per IP)
- D) Authenticated rate limiting (require API key)

**Analysis:**

- Fast relay is operator-controlled endpoint, not public API
- Operator can use reverse proxy (nginx) for rate limiting if needed
- Simple global limit prevents accidental flooding

**Recommendation**: **Option B** - Simple global rate limit (100 req/min). Add per-IP or authentication later if needed.

### 3. Job TTL and cleanup?

**Recommendation**: 1 hour TTL, cleanup task every 5 minutes. After 1 hour, job is deleted and GET returns 404. This is sufficient for UI polling.

### 4. Handle duplicate submissions?

**Recommendation**: Allow duplicates. MessageProcessor already deduplicates by message_id. Fast relay can safely inject same message multiple times.

### 5. Error handling strategy?

**Options:**

- A) Return error immediately if tx not found / invalid
- B) Queue for retry with backoff
- C) Return job_id, update status to Failed asynchronously

**Recommendation**: **Option C** - Always return job_id immediately (fast response). Update job status asynchronously. UI polls and sees error state.

### 6. Authentication / Authorization?

**Options:**

- A) No authentication (open endpoint, rely on rate limiting)
- B) API key authentication
- C) Signature-based authentication (sign tx_hash with private key)

**Analysis:**

- Relayer operator controls deployment, not public API
- Rate limiting prevents abuse
- Can add auth later if needed

**Recommendation**: **Option A** - No authentication initially. Operator can use reverse proxy (nginx) for IP whitelisting if needed. Add API key auth in Phase 6 if production deployment requires it.

## Measured Performance Analysis

### Local Test Environment (Anvil, 12s Block Time)

**Measured Results (20 transfers):**

- Average: 11.29s
- Minimum: 4.83s
- Maximum: 22.86s
- Median: 10.96s

**Time Breakdown (11.29s average):**
| Component | Time | Can Fast Relay Improve? |
|-----------|------|------------------------|
| Discovery (DB loader tick) | ~1s | ✅ Yes - bypass entirely |
| Metadata building (validators) | ~2-3s | ✅ Yes - trust UI, validate async |
| Destination block inclusion | ~6-8s | ❌ No - fundamental blockchain limit |
| Other overhead (queues, RPC) | ~0.5-1s | ⚡ Partial - faster injection |

**Expected with Fast Relay:**

- Time saved: ~3-5 seconds
- Projected average: **7-9 seconds**
- Improvement: **27-44% faster**

### Production Environment (With Scraper)

**Current Flow Timing:**
| Component | Time | Notes |
|-----------|------|-------|
| Scraper indexing | 10-30s | Indexes for Explorer DB |
| Relayer indexing | 10-30s | Independent indexing |
| DB loader discovery | 1s | Tick cycle |
| Metadata building | 2-5s | Validator signatures |
| Destination block | 6-12s | Depends on chain |
| **Total** | **29-78s** | Highly variable |

**With Fast Relay:**

- Time saved: **23-65+ seconds**
- Projected time: **6-15 seconds** (only destination block + metadata)
- Improvement: **75-85% faster**

### Key Insights

1. **Local vs Production**: Local setup (no scraper) is already fast (~11s). Production has major scraper delays (20-60s).

2. **Fundamental Limit**: Destination block time (~6-12s) cannot be bypassed. This is the floor for any relay system.

3. **Fast Relay Value**:
   - **Local**: Modest improvement (3-5s saved)
   - **Production**: Dramatic improvement (20-60s saved)
   - **User Experience**: Immediate feedback via job_id, predictable timing

4. **Coexistence with Normal Indexing**:
   - Fast relay is **additive**, not a replacement
   - Normal indexing continues in background
   - Provides audit trail and handles non-fast-relayed messages
   - Fast relay is opt-in for performance-critical flows (UI-initiated)

## Integration with Existing Indexer

### Dual-Path Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Message arrives on origin chain                        │
└─────────────────────────────────────────────────────────┘
              ↓                           ↓
    ┌─────────────────┐         ┌─────────────────┐
    │  NORMAL PATH    │         │   FAST PATH     │
    │  (Background)   │         │  (UI-triggered) │
    └─────────────────┘         └─────────────────┘
              ↓                           ↓
    ContractSync indexes         UI calls POST /fast_relay
              ↓                           ↓
    Writes to RocksDB            Fetches tx receipt via RPC
              ↓                           ↓
    DB Loader discovers          Extracts message immediately
              ↓                           ↓
          MessageProcessor ← ← ← ← Both paths converge
              ↓
    Deduplication (by message_id)
              ↓
    Prepare → Submit → Confirm
```

### Deduplication Strategy

MessageProcessor already has built-in deduplication:

- Uses message_id as unique key
- If message already in flight (preparing/submitting), skip duplicate
- Fast relay and normal indexing can both submit same message safely

### When to Use Each Path

| Scenario                           | Path            | Reason                                 |
| ---------------------------------- | --------------- | -------------------------------------- |
| UI-initiated transfer              | Fast relay      | User expects immediate feedback        |
| Background message relay           | Normal indexing | No user waiting, audit trail important |
| Validator/watcher detected message | Normal indexing | Automated monitoring                   |
| Retry after failure                | Fast relay      | Recover quickly from transient errors  |
| Historical message backfill        | Normal indexing | Bulk processing, no time pressure      |

## Verification

**Test Plan:**

**Phase 1: Local Testing (Anvil)**

1. Run measurement script baseline: `./scripts/measure-relay-time.sh 20`
2. Start relayer with fast relay API enabled
3. Modify script to call POST /fast_relay after each tx
4. Run modified script, compare times
5. Expected: 7-9s average (vs 11s baseline)

**Phase 2: Testnet Testing**

1. Deploy modified relayer to testnet
2. Create CCTP transfer via UI
3. Call `/fast_relay POST` with tx hash
4. Verify job created and status returned
5. Poll `/fast_relay/:id GET` until confirmed
6. Compare timing vs normal relay path (expect 20-60s savings)
7. Verify message delivered on destination

**Phase 3: Coexistence Testing**

1. Send 10 messages via fast relay
2. Send 10 messages via normal path (no API call)
3. Verify all 20 messages delivered correctly
4. Check logs for deduplication behavior
5. Verify no interference between paths

**Success Criteria:**

- **Local**: 3-5 seconds faster than normal path
- **Production**: 20+ seconds faster than normal path
- 99%+ reliability for transactions with available attestations
- Clear error states when Circle API unavailable
- No impact on normal relay path performance
- Proper deduplication when same message submitted via both paths
