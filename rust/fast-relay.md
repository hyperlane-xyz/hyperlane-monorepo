### Current Slow Implementation - Complete Flow

┌─────────────────────────────────────────────────────────────┐
│ USER ACTION: Transfer USDC via CCTP                        │
│ - UI calls TokenBridge.transferRemote()                    │
│ - Burns tokens + dispatches Hyperlane message              │
│ - Circle's MessageTransmitter emits MessageSent            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ SCRAPER (Delay 1: 10-30 seconds)                           │
│ - Polls origin chain every 5-10 seconds                    │
│ - Indexes Mailbox.Dispatch event                           │
│ - Indexes CCTP MessageSent event                           │
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
│ - Calls ISM.getOffchainVerifyInfo()                       │
│ - Catches OffchainLookup revert                           │
│ - Extracts offchain-lookup-server URL                     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ OFFCHAIN LOOKUP SERVER (Delay 4: 2-5 seconds)             │
│ Step 1: Query Hyperlane Explorer GraphQL                  │
│   - Lookup message_id in raw_message_dispatch table       │
│   - Wait for database query (100-500ms)                   │
│   - Get origin_tx_hash                                     │
│                                                             │
│ Step 2: Fetch origin transaction receipt                  │
│   - RPC call to origin chain (200-1000ms)                 │
│   - Parse logs to extract CCTP MessageSent event          │
│                                                             │
│ Step 3: Query Circle Attestation API (Delay 5: 1-10s)    │
│   - POST to Circle's attestation service                  │
│   - Circle may not have attestation ready yet             │
│   - May need multiple retries with backoff                │
│   - Returns [cctpMessage, attestation]                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ MESSAGE PROCESSOR - SUBMIT STAGE                           │
│ - Submits tx with CCTP attestation metadata               │
│ - Mailbox.process() → ISM.verify() → CCTP verification    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ MESSAGE PROCESSOR - CONFIRM STAGE (Delay 6: 10 minutes)   │
│ - Waits for finality period                               │
│ - Verifies tx inclusion post-reorg window                 │
└─────────────────────────────────────────────────────────────┘
                            ↓
                    Transfer Complete!

TOTAL DELAY BEFORE RELAY STARTS: 23-65+ seconds
  - Scraper indexing: 10-30s
  - Relayer indexing: 10-30s
  - DB loader scan: 1s
  - Explorer query: 0.5s
  - RPC fetch: 1s
  - Circle attestation: 1-10s (often much longer if not ready)
Identified Bottlenecks
1. Duplicate Indexing
Scraper indexes for Explorer (10-30s delay)
Relayer indexes same events again (10-30s delay)
Total: 20-60 seconds of redundant work
2. Explorer Dependency
Offchain lookup server queries Explorer GraphQL
Adds database roundtrip latency
Requires Scraper to have already indexed
Creates coupling between services
3. Circle Attestation Wait
Circle API may not have attestation ready immediately
Server must retry with exponential backoff
Can add 1-10+ seconds (sometimes minutes for congested periods)
4. DB Write/Read Cycles
Scraper writes to Explorer DB
Relayer writes to local RocksDB
DbLoader reads from RocksDB
Multiple persistence layers slow propagation


### Fast Implementation - Proposed Architecture

┌─────────────────────────────────────────────────────────────┐
│ USER ACTION: Transfer USDC via CCTP                        │
│ - UI calls TokenBridge.transferRemote()                    │
│ - Transaction mined on origin chain                        │
│ - UI receives transaction receipt                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ UI CALLS: POST /fast_relay                                 │
│ Body: {                                                     │
│   origin_chain: "ethereum",                                │
│   tx_hash: "0x123...",                                     │
│   priority: "high" (optional)                              │
│ }                                                           │
│ Response: { job_id: "uuid-1234" }                         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ FAST RELAY ENDPOINT (< 1 second)                          │
│                                                             │
│ 1. Validate request (rate limit check)                    │
│ 2. Fetch tx receipt from RPC (200-500ms)                  │
│ 3. Extract Hyperlane Dispatch event                       │
│ 4. Extract CCTP MessageSent event                         │
│ 5. Create in-memory relay job                             │
│ 6. Return job_id immediately                              │
│                                                             │
│ ⚡ No scraper wait                                         │
│ ⚡ No explorer query                                       │
│ ⚡ No relayer indexing delay                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ ASYNC RELAY WORKER (runs in background)                   │
│                                                             │
│ 1. Create PendingMessage from extracted event             │
│ 2. Inject directly into MessageProcessor queue            │
│    - Bypasses DB entirely                                 │
│    - Bypasses DbLoader                                    │
│                                                             │
│ 3. PREPARE STAGE:                                         │
│    a) Build ISM metadata (CCTP attestation)               │
│       - Query Circle API directly                         │
│       - No Explorer dependency                            │
│       - Can poll Circle API with retries                  │
│    b) Update job status: "preparing"                      │
│                                                             │
│ 4. SUBMIT STAGE:                                          │
│    a) Submit tx to destination Mailbox                    │
│    b) Update job status: "submitted"                      │
│    c) Store tx_hash in job                                │
│                                                             │
│ 5. CONFIRM STAGE:                                         │
│    a) Wait for finality (10 min)                          │
│    b) Verify inclusion                                    │
│    c) Update job status: "confirmed"                      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ UI POLLS: GET /fast_relay/:job_id                         │
│ Response: {                                                 │
│   status: "confirmed",                                     │
│   destination_tx_hash: "0xabc...",                        │
│   created_at: "2024-03-11T...",                           │
│   updated_at: "2024-03-11T..."                            │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
                            ↓
                    Transfer Complete!

TOTAL DELAY BEFORE RELAY STARTS: < 1 second
  - RPC tx fetch: 0.2-0.5s
  - Event extraction: 0.1s
  - Queue injection: 0.01s

TIME SAVINGS: 22-64+ seconds eliminated!