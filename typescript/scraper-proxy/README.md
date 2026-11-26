# Scraper proxy

The scraper proxy is the read-only query and streaming gateway for Hyperlane
message data. It combines:

- authoritative on-chain data indexed by scrapers;
- optional relayer diagnostics describing message-processing progress; and
- live PostgreSQL notifications for low-latency updates.

Explorer, Nexus, agents, and other services can query history or consume live
updates without receiving database credentials.

The proxy does **not** accept data ingestion over HTTP or WebSocket. Scrapers and
relayers write to their databases; downstream services read through the proxy.

## Architecture

```text
 Chain RPCs                              Relayer runtime
     │                                         │
     ▼ indexed by                              ▼ writes activity
┌──────────────────────┐              ┌────────────────────────┐
│ Scraper agents       │              │ Relayers               │
└──────────┬───────────┘              └───────────┬────────────┘
           │ writes chain data                    │
           ▼                                      ▼
┌─────────────────────────────┐        ┌─────────────────────────────┐
│ Scraper PostgreSQL          │        │ Diagnostics PostgreSQL      │
│                             │        │                             │
│ dispatches, deliveries,     │        │ message_activity: retries,  │
│ gas payments, Merkle        │        │ ISM progress, submission,   │
│ insertions, block heads,    │        │ confirmation, delivery      │
│ message projections         │        │ observations                │
└──────────────┬──────────────┘        └──────────────┬──────────────┘
               │ SELECT + LISTEN/NOTIFY               │
               └──────────────────┬────────────────────┘
                                  ▼
                       ┌──────────────────────────┐
                       │ scraper-proxy :8383      │
                       │                          │
                       │ /graphql   historical    │
                       │ /agents    protocol WS   │
                       │ /messages  message WS    │
                       │ /metrics   Prometheus    │
                       └──────┬───────────┬───────┘
                              │           │
                ┌─────────────▼──┐   ┌────▼──────────────┐
                │ Nexus/Explorer │   │ Agents and other  │
                │ message views  │   │ internal services │
                └────────────────┘   └───────────────────┘
```

The scraper database and diagnostics database remain separate:

| Source                         | Writer         | Meaning                                                           | Proxy interfaces                          |
| ------------------------------ | -------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| Scraper PostgreSQL             | Scraper agents | Indexed on-chain state and canonical delivery                     | GraphQL, `/agents`, `/messages`           |
| Relayer diagnostics PostgreSQL | Relayers       | Relayer observations, retries, ISM progress, submission lifecycle | GraphQL, optional `/messages` diagnostics |

Scraper `is_delivered` is the authoritative indexed on-chain state. A diagnostic
`delivered` phase means a relayer observed delivery; it is useful for latency and
debugging but does not replace scraper state.

## Choose an interface

| Interface           | Use it for                                                               | Delivery model                      | Intended clients                  |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------- | --------------------------------- |
| `GET/POST /graphql` | Historical queries, pagination, message snapshots, diagnostic history    | Request/response                    | Explorer, Nexus, services         |
| `WS /messages`      | Enriched message updates, selected message IDs, block heads, diagnostics | Server pushes after URL negotiation | Explorer, Nexus, public consumers |
| `WS /validators`    | Merkle tree insertions for exactly one domain and confirmation policy    | Server pushes after URL negotiation | Public validators                 |
| `WS /agents`        | Live protocol events at canonical or custom confirmations                | Client sends a subscription         | Internal agents and indexers      |
| `GET /metrics`      | Request, database, WebSocket, queue, and process metrics                 | Prometheus scrape                   | Monitoring                        |

## GraphQL

`/graphql` exposes read-only data from the scraper database and, when configured,
the relayer diagnostics database.

Main queries:

| Query                     | Data                                                                 |
| ------------------------- | -------------------------------------------------------------------- |
| `domain` / `domain_by_pk` | Domain metadata                                                      |
| `message_view`            | Enriched dispatch, delivery, transaction, and gas-payment projection |
| `message_view_aggregate`  | Counts and aggregate message queries                                 |
| `raw_message_dispatch`    | Raw indexed dispatches                                               |
| `message_activity`        | Paginated raw relayer diagnostic history                             |
| `message_diagnostics`     | Latest diagnostic snapshot/update envelope for one message           |

The complete filter, ordering, cursor, and field contract lives in
[scraperdb-schema.graphql](src/graphql/scraperdb-schema.graphql).

### Message history

Canonical message history uses scraper finality:

```graphql
query RecentMessages {
  message_view(order_by: [{ id: desc }], limit: 25) {
    msg_id
    origin_domain
    destination_domain
    sender
    recipient
    send_occurred_at
    is_delivered
    delivery_occurred_at
    origin_tx_hash
    destination_tx_hash
    total_payment
  }
}
```

Pass `confirmations: N` to request a provisional snapshot at `N` blocks behind
the current chain head. Domains without near-head scraper state remain canonical.
Custom snapshots accept an exact message or transaction identifier, or a
zero-confirmation provisional-only feed. They cap the affected event scan at
10,000 rows and accept up to 1,000 confirmations.

Public history pages support ID ordering and cursors. Filter by message or
transaction identifiers, participant addresses, domains, or send times.
Read delivery status on returned rows and filter each canonical page locally.
The provisional-only feed also supports delivery filtering and send-time
ordering. Identifier lookups support nonce ordering and counts. History
offsets and distinct queries are disabled. Pages contain at most 500 rows.
PostgreSQL estimates each history statement before execution. The maximum is
100,000 estimated cost units per
statement and 250,000 across the operation. The database statement timeout
also applies. At most 25 GraphQL database statements may remain active or
queued, including work whose HTTP client disconnected.

For a combined live list:

1. Page canonical history normally.
2. Query provisional rows with `confirmations: 0` and
   `where: {is_provisional: {_eq: true}}`.
3. Merge by `msg_id`, prefer provisional fields, and sort by send time.

Only canonical pages should be used as durable history cursors.

### Merkle tree insertion history

The same `/graphql` endpoint exposes confirmed insertions for one domain and
Merkle hook, using the existing history database pool/read replica:

```graphql
query Insertions($domain: bigint!, $hook: bytea!, $from: bigint) {
  merkle_tree_insertions(
    domain: $domain
    merkle_tree_hook: $hook
    from_index: $from
    limit: 1000
  ) {
    insertions {
      domain
      merkle_tree_hook
      leaf_index
      message_id
      block_number
    }
    next_index
  }
}
```

`from_index` is inclusive. Omit it to start at zero. Omit `limit` to request
1,000 leaves, or supply a value between 1 and 1,000. Explicit `null` is invalid
for either argument. When `next_index` has a value, pass it as the next request's
`from_index`. A null cursor means no further confirmed rows are currently available. If the
page is empty, retry later with the same `from_index` (zero if omitted). If the
page contains leaves, poll later from the last returned leaf index plus one. Stop polling
if the last index is 4,294,967,295, the largest cursor the API accepts. Clients
must detect missing sequences and independently verify roots before signing.

Fetch a single leaf with
`merkle_tree_insertion(domain: $domain, merkle_tree_hook: $hook, leaf_index: $index)`;
it returns the same insertion fields, or null if absent or not yet confirmed.
Domains and leaf indices accept unsigned 32-bit values through `bigint`.
Hook addresses accept `0x` or `\x` hex prefixes and must match the stored 20-byte
or 32-byte address. Both queries inherit existing GraphQL admission, query-plan
budgets, timeouts, and optional `@cached` response caching.

### Relayer diagnostics

```graphql
query MessageDiagnostics {
  message_activity(message_id: "0x...", limit: 100) {
    activities {
      id
      relayer
      observed_at
      received_at
      version
      activity
    }
    has_more
    next_before_id
  }

  message_diagnostics(message_id: "0x...") {
    version
    message_id
    partial
    relayers {
      relayer
      phase
      observed_at
      retry {
        reason
        count
        next_attempt_at_millis
      }
      modules {
        ism
        module_type
        verification
        verified
        threshold
        routed_module
        modules
        signatures {
          collected
          threshold
          unavailable {
            validator
            reason
          }
        }
        reorg_checks {
          validator
          states
        }
      }
    }
  }
}
```

`message_activity` is newest first. `before_id` is exclusive; use
`next_before_id` to fetch the next page. Limits are 1–500, defaulting to 100.
IDs are strings to preserve PostgreSQL bigint precision in JavaScript.
The proxy does not prune diagnostic history; current relayer database retention
is indefinite.

`message_diagnostics` returns the latest full snapshot and newest cumulative
update per relayer in `activities`. Apply those activities to render the current
ISM tree and lifecycle. The `relayers` field remains a compatibility reduction
for older diagnostic event rows. Raw paginated history remains available when a
consumer needs the exact timeline.

In raw history, prepare start appears as `activity.state.checks.prepare = "started"`.
A successful gas preflight sets `activity.state.checks.gas_preflight = "succeeded"`.
Validator-set resolution sets `checks.validator_set = "succeeded"` on the ISM
node in `activity.state.modules`, alongside its `validators` and `threshold`.
Use the row's `observed_at` when the marker first appears for that attempt and
relayer. Cumulative snapshot updates can repeat markers. `received_at` records
database arrival, and older rows may omit these markers.

`modules.reorg_checks` shows per-validator reorg observations when available.
States include `reorg_not_found`, `reorg_reported`, and `reorg_check_failed`.
An ignored report includes both `reorg_reported` and `reorg_ignored`.
Use `message_activity.activities.observed_at` to track when reorg observations
change, as with signature progress.

Diagnostics errors use the GraphQL code `DIAGNOSTICS_UNAVAILABLE` when the
diagnostics database is disabled or unavailable. Other scraper queries continue
to work.

## Message WebSocket: `/messages`

`/messages` is the consumer-facing stream used by Explorer and Nexus. The
subscription is declared in URL query parameters; clients do not send a
`subscribe` frame. Reconnect with a new URL to change the subscription.

### Connection modes

| URL                                          | Result                                                              |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `/messages`                                  | All canonical enriched message updates                              |
| `/messages?messageIds=0xID1,0xID2`           | Updates only for the selected IDs                                   |
| `/messages?messageIds=`                      | No message updates; useful with `blocks=true`                       |
| `/messages?blocks=true`                      | Message updates plus indexed block-head snapshots and changes       |
| `/messages?confirmations=2&domains=1,42161`  | Message projection two blocks behind the head for supported domains |
| `/messages?diagnostics=true&messageIds=0xID` | Message updates plus relayer diagnostics for selected IDs           |

`messageIds` accepts at most 50 IDs. It filters the updates sent to that socket. Diagnostics requires between 1 and 50 explicit IDs.

Production `/messages` requests must include a valid `CF-Connecting-IP` header.
The direct peer must be the loopback cloudflared sidecar. Each proxy accepts at
most **500 message connections**. At most five connections
are allowed per client IP. Unfinished setup reads are capped at 32 globally and
two per IP; disconnecting does not release their reservation until the read ends.
Subscription URLs are capped at 8 KiB, with at most 512 domains and 1,000
confirmations. Application frames from clients are rejected with code 1008;
WebSocket protocol pongs remain supported.
Subscriptions also have a 10,000 domain-confirmation-block budget, counting zero
confirmations as one block for this admission check.

Each proxy instance shares one head snapshot and one paginated dispatch,
delivery, and payment range per active domain. The first advance starts at the
oldest active subscriber frontier. A deeper subscriber extends the retained
range backward as needed. Joining and reconnecting use the current
in-memory heads. Delivery and gas totals use the requested confirmation count
on negotiated custom domains and scraper finality elsewhere. Late receipts
refresh the shared message data. Relayer diagnostics use their own database.

The range stores heights and IDs. Full rows are read only for IDs that at least
one browser needs, in batches of 64 with at most two fact queries in flight.
Block-only subscriptions skip message reads. Explorer outbound queues share
a 32 MiB limit across sockets.
When this budget fills, the largest queued subscriber is disconnected first.
Queued scans recheck subscriber interest before issuing database work.

Range reads run on at most four domains concurrently. The source retains at
most 50,000 changes and 64 MiB of serialized message facts, with at most 256
delivery candidates per message. Gas payments keep the 8 oldest and 8 newest
block heights per paying domain exact and fold the rest into one bucket at its
newest height, which a subscriber sees once that height is within its
frontier. During a payment flood, a subscriber with 8 or more confirmations can
see a message's total fall below a value it already received until the fold's
newest payment reaches its frontier; zero-confirmation subscribers stay exact.
A subscription that falls outside the retained window
or cannot obtain a complete projection disconnects and can reconnect at the
current head.
Invalid message facts are isolated by message ID. A global custom stream emits
the existing `error` frame with `messageId` and `error` and continues with other IDs.
An explicit ID subscription disconnects if its message cannot be projected.
Domain recovery failures disconnect overlapping message subscriptions while
unrelated domains and block-only subscriptions continue. Multi-domain browsers
reconnect when a subscribed domain fails.

### Frames

The first frame describes the negotiated stream:

```json
{
  "type": "ready",
  "eventTypes": [
    "message_upsert",
    "block",
    "diagnostics",
    "diagnostics_unavailable"
  ],
  "messageIds": ["\\x..."],
  "confirmations": 2,
  "domains": [1, 42161],
  "customDomains": [1],
  "canonicalDomains": [42161]
}
```

Fields not requested are omitted. `customDomains` identifies domains using the
requested confirmation delay; `canonicalDomains` identifies domains retaining
scraper finality.

Server frame types:

| `type`                    | Meaning                                                               | Important fields                                                      |
| ------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `message_upsert`          | Insert or replace the enriched message projection                     | `data`, optional `confirmations`                                      |
| `rollback`                | Previously exposed custom-confirmation data above a height is invalid | `domain`, `fromHeight`, `toHeight`, `confirmations`                   |
| `block`                   | Current indexed block for a domain                                    | `domain`, `height`, `hash`, `headHeight`                              |
| `diagnostics`             | Current diagnostic snapshot for one message                           | `data.version`, `data.message_id`, `data.relayers`, `data.activities` |
| `diagnostics_unavailable` | Diagnostic reads failed without closing normal message updates        | `message_ids`, `message`                                              |
| `error`                   | Negotiation or runtime error                                          | `error`                                                               |

Treat `message_upsert` as replacement state keyed by message ID. After a
`rollback`, remove or reload state above `toHeight`; replacement upserts follow.
Block heights are decimal strings and can decrease or change hash after a reorg.

### Diagnostics behavior

Relayers persist versioned `snapshot` and `snapshot_update` activities:

- a full snapshot anchors initial state, `ready_to_submit`, and terminal state;
- intermediate updates replace only changed ISM nodes and message-level state;
- stable `node_id` values let consumers update the existing ISM tree; and
- retries, failures, signature progress, offchain reads, and submission stages
  remain available without repeating an unchanged full tree.

The proxy packages the latest anchor and cumulative update into the
`diagnostics` frame's `data.activities`. `snapshot` and `snapshot_update` are
nested activity types, not separate top-level WebSocket frame types. Replace the
previous state for that message; do not append the entire frame as new history.
GraphQL remains the source for older activity pages.

The `relayers` projection in both GraphQL and WebSocket responses understands
full snapshots and cumulative updates, including node replacements and removals.
Snapshot nodes use `node_id` identity, so repeated ISM addresses remain distinct.
Collection IDs and offchain attempt counters are nullable when omitted by the
snapshot producer; legacy events retain their original values.

The bounded snapshot selection retains anchors and updates together. Legacy
events newer than a reporter's latest snapshot state are included, so rolling
back a writer does not leave its status frozen at an older snapshot. Truncated
responses remain marked `partial`; older history is available through GraphQL.

PostgreSQL notifications are wakeups, not the data payload. Notifications are
coalesced, and the proxy reloads only affected watched IDs. New subscriptions are
read once; there is no periodic polling. After a listener reconnect, the proxy
refreshes watched IDs to repair missed notifications.

Diagnostic streaming is best effort. If its database is down, normal message
updates stay connected and `diagnostics_unavailable` marks the last snapshot as
stale. The proxy retries affected IDs and publishes fresh state after recovery.

Capacity is 200 unique diagnostic IDs globally and 50 per client IP across
connections. Frames may be skipped and retried when normal message traffic or
outbound byte limits have priority.

Missing diagnostic fields mean unobserved, not zero or success. Never infer ISM
verification from signature counts, metadata success, absent events, or a failed
validator read. The proxy performs no background signature reads or verification.

## Validator WebSocket: `/validators`

This public, live-only endpoint emits only `merkle_tree_insertion` events. Choose
exactly one domain and an optional confirmation count in the connection URL:

```text
wss://<public-scraper-host>/validators?domain=1
wss://<public-scraper-host>/validators?domain=1&confirmations=12
wss://<public-scraper-host>/validators?domain=1&confirmations=0
```

The domain must exist in the scraper DB's `domain` table. Omitted confirmations
use the scraper's configured canonical policy. An explicit nonnegative safe
integer up to 1,000 uses the custom-confirmation flow, capped by indexed progress; zero
streams near-head events. Custom counts require near-head state and never fall
back to canonical. Keep the policy consistent with the validator's configuration.

The server validates the URL and automatically subscribes. It sends `ready` with
`domain`, optional `confirmations`, `eventTypes: ["merkle_tree_insertion"]`,
`historicalStreaming: false`, and `liveStartVersion: 1` before any events or
`live_start`/`live_start_unavailable` frames. There is no client subscribe message,
`subscribed` acknowledgement, or subscribe deadline. Reconnect to change policy.
Only `{"type":"ping"}` application messages are accepted. Additional/duplicate URL
parameters, domain lists, replay options and subscription messages are rejected.

The handoff uses the same boundaries as `/agents`: domain, height/hash, Merkle
hook address and optional confirmation count. Buffer from `ready`, recover history
through RPC, verify the boundary through RPC, then hand off after catching up.
Unavailable boundaries, disconnects and rollbacks retain or restore RPC indexing.
Configure the Rust validator's `websocketUrl` with the `/validators` endpoint and
no query parameters. It supplies its origin domain and numeric reorg period;
block-tag policies omit confirmations and use the scraper's canonical policy.
It validates the negotiated policy before using the existing RPC handoff.
No WebSocket backfill is performed.

Limits per process: **2,000 validator connections**, 100 per exact client IP address,
32 unfinished setups in total, and 8 unfinished setups per IP budget. URLs/client frames
are limited to 1 KiB and application messages to 30 per minute. Admission limits
reject with HTTP 400/403/429/503 before upgrading. Disconnected setups retain
connection, IP and setup reservations until their DB work ends. Connection/IP
reservations also remain until the socket has actually closed.

Agents and validators reuse the event-source implementation with separate instances,
retention, and read admission. Each route shares one custom range per
`(domain, eventType)` per proxy process across its confirmation counts. Connections own release cursors;
new head ranges are read once, and cached rows are released as each policy matures.
The validator URL is adapted to the same event subscription setup used by agents,
with the Merkle event type and one domain fixed by the endpoint.
Connecting still takes a current checkpoint snapshot for the RPC handoff.
Events are serialized once per effective count and broadcast through independent
bounded FIFOs. The final subscriber disconnecting releases its range.
Heartbeat limits also apply.

The agent source admits at most 2,048 ranges and four concurrent scans. The
validator source admits at most 512 ranges and two concurrent scans. Their
combined retained and loading data are bounded to 50,000
rows and 64 MiB of serialized event data. A single range load accepts at most
5,000 rows / 4 MiB. Oversized joining ranges fail only the deeper subscribers;
cache pressure sheds retaining policies within the affected route. Failed policies have a 30-second
retry cooldown. Clients retain their existing RPC recovery on disconnect.
Each socket has a 2,000-frame / 16 MiB queue. Aggregate queue budgets are 16 MiB
for agents, 8 MiB for validators, and 32 MiB for messages. Canonical events and
block frames use the same paced queues. Queued bytes/messages are exposed by route.
In-flight sends reserve half the process byte budget for agents and a quarter
each for validators and messages (with a 1 KiB minimum capped by the process
budget). Control frames share those quotas. Buffer pressure sheds the largest
pending sender in the affected route; disconnects release its reservation immediately.

Validator-only reads use a dedicated five-connection primary pool with acquisition
timeouts and separate scan admission. Custom agent ranges always use the live
pool; validator subscriptions cannot expand or pin them. Canonical events already needed by internal agents reuse that existing
live-pool read and broadcast, without adding a public query to the live pool.
Validator-only canonical publication has its own bounded queue and worker, so
waiting for that pool does not stall internal agent notification or head drains.
The database server and outbound resources remain shared.

Validator metrics use the `hyperlane_scraper_proxy_` prefix:

| Metric                                                                                      | Labels / meaning                                                                               |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `websocket_connections`, `websocket_connection_limit`                                       | `route="validators"`: active connections and the 2,000-connection cap                          |
| `websocket_connections_total`, `websocket_connection_rejections_total`                      | Accepted/rejected connections by route and reason                                              |
| `websocket_validator_subscriptions`                                                         | Active subscriptions by `domain` and `policy="canonical"` or `"custom"`                        |
| `websocket_validator_reserved_connections`                                                  | Connections counted against the cap, including closing sockets and disconnected pending setups |
| `websocket_validator_pending_setups`, `websocket_validator_setup_limit`                     | Unfinished DB setups and the global setup cap                                                  |
| `websocket_validator_shared_readers`                                                        | Active custom validator ranges, one per domain across policies                                 |
| `websocket_queued_bytes`, `websocket_queued_messages`                                       | Queue backlog by `route` (`agent`, `validators`, `messages`)                                   |
| `websocket_validator_client_ips`                                                            | Public IP budgets currently reserved                                                           |
| `websocket_validator_max_connections_per_ip`, `websocket_validator_connection_limit_per_ip` | Largest public IP reservation count and its limit                                              |
| `websocket_validator_client_message_limit_bytes`                                            | Inbound frame limit                                                                            |
| `database_pool_waiting_requests`, `database_pool_connection_limit`                          | `pool="validator"`: queued reads and five-connection cap                                       |
| `database_queries_total`, `database_query_duration_seconds`                                 | `role="validator_primary"`: validator DB load and latency                                      |

Subscriptions exclude validators from the agent subscription gauge. Labels never
contain client IPs or arbitrary confirmation counts. Domain series disappear when
the last subscription disconnects.

In production, all validators require a valid `CF-Connecting-IP` from the
loopback cloudflared sidecar. Only loopback peers may supply that header.
Direct private-network connections are rejected as well. Keep the service origin
private. Cloudflared must connect to a loopback origin.

Rate-limit upgrades/reconnects and handle subnet-level abuse at Cloudflare;
the proxy does not group IPv6 subnets. Distributed clients and distinct
confirmation policies can still occupy public capacity and consume shared DB
resources. The remotely managed tunnel must allow the exact `/validators` path;
adding the endpoint does not modify the deployed tunnel configuration.

Mainnet/testnet validator contexts use `wss://explorer-api.hyperlane.xyz/validators`,
on the same public host as `/messages` and `/graphql`. The Rust binary accepts only
a query-free `ws://` or `wss://` URL ending in `/validators`.
No new cluster or database migration is required.

## Agent WebSocket: `/agents`

`/agents` provides live protocol events for agents and indexers. The endpoint is
cluster-only:

```text
ws://scraper-proxy.<namespace>.svc:8383/agents
```

Agents must recover startup history and reconnect gaps through RPC before
cutting over to live events.

On connection, the server advertises its capabilities:

```json
{
  "type": "ready",
  "eventTypes": [
    "dispatch",
    "delivery",
    "gas_payment",
    "merkle_tree_insertion",
    "blocks"
  ],
  "historicalStreaming": false,
  "liveStartVersion": 1,
  "confirmations": { "unit": "blocks", "liveOnly": true, "byDomain": true }
}
```

Send one subscription containing each desired event type at most once. Omit
`domains` for all domains, or list explicit domains. Client frames are limited to
64 KiB:

```json
{
  "type": "subscribe",
  "streams": [
    { "eventType": "dispatch", "domains": [1, 42161] },
    { "eventType": "gas_payment", "domains": [1, 42161] },
    { "eventType": "delivery" },
    { "eventType": "blocks", "domains": [1, 42161] }
  ]
}
```

### Available streams

| `eventType`             | Data                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `dispatch`              | Raw dispatch, origin/destination, mailbox, sender, recipient, body, tx/block |
| `delivery`              | Delivered message ID, destination mailbox/domain, destination transaction    |
| `gas_payment`           | Message ID, payment, gas amount, IGP, origin/destination, tx/log metadata    |
| `merkle_tree_insertion` | Message ID, Merkle tree hook, leaf index, domain, block                      |
| `blocks`                | Current indexed block snapshot followed by live changes                      |

Every event subscription starts live, including after reconnect. Replay options
such as `cursors`, `streamCursorVersion`, `afterSequence`, `afterStreamCursor`,
`afterId`, and `allowReplay` are rejected, even when empty. No historical database
scan or `caught_up` message is issued. Gas payment events retain their row ID and
log metadata, without replay cursors or legacy cursor boundaries.

### Live-start boundary

Live agent event subscriptions automatically receive handoff boundaries; there
is no opt-in flag. Check `liveStartVersion: 1` in `ready` for server support.
Blocks-only subscriptions do not receive a boundary.
This applies to `/agents`, not the Explorer `/messages` endpoint.
A validator can request only Merkle insertions; a relayer requests all three:

```json
{
  "type": "subscribe",
  "streams": [
    { "eventType": "dispatch", "domains": [1] },
    { "eventType": "merkle_tree_insertion", "domains": [1] },
    { "eventType": "gas_payment", "domains": [1] }
  ]
}
```

After `subscribed`, canonical streams receive one boundary for each requested
domain, including quiet chains with no events. Unscoped subscriptions receive
boundaries for available domains:

```json
{
  "type": "live_start",
  "domain": 1,
  "height": "100",
  "hash": "<checkpoint hash as 0x-prefixed 32-byte hex>",
  "streams": [
    {
      "eventType": "dispatch",
      "address": "0x1111111111111111111111111111111111111111"
    },
    {
      "eventType": "merkle_tree_insertion",
      "address": "0x2222222222222222222222222222222222222222"
    },
    {
      "eventType": "gas_payment",
      "address": "0x3333333333333333333333333333333333333333"
    }
  ]
}
```

For canonical streams, the proxy registers **all requested event streams before
reading the boundary** from the primary database. One SQL snapshot joins the healthy, non-halted
`scraper_head.confirmed_height` to its retained `scraper_checkpoint` hash and
contract addresses. The proxy DB role needs SELECT access to both tables.

Custom streams (e.g. `"confirmations": 2`) receive a boundary per event type and
domain with `"confirmations": 2` on the frame. Its height is the latest retained
checkpoint at or below `min(indexed_height, head_height - 2)`, using the same
primary SQL snapshot that initializes that stream. Streams with the same
confirmation count and domain set share that snapshot; setup rollbacks force a
fresh read. It never substitutes the
canonical confirmation policy. Sparse checkpoints can place the boundary below
the numeric target; live reading then covers the interval above that boundary.
With `includeZeroConfirmations`, the requested and additional zero-confirmation
streams get separate markers; the latter has `"confirmations": 0`. No historical replay is
requested or performed.

If the requested frontier is older than retained checkpoints, the boundary is
unavailable. A rollback during initialization retries the snapshot; a rollback
after initialization invalidates that boundary. A missing boundary never grants
permission to switch to WebSocket authority.

**Consumer handoff contract:**

1. Buffer live events from `subscribed` onward, including events arriving before
   `live_start` while its database read is in flight.
2. Verify the returned contract addresses and boundary hash against independent
   RPC. Complete RPC history through **at least** that boundary for every required
   event type, respecting the consumer's confirmation policy and indexing window.
3. Stop and join the RPC indexers, then drain the buffered live events with overlap
   deduplication and sequence checks. No new dispatch or insertion is required.
4. For custom streams, match the marker's confirmation count as well as domain
   and event type. Handle rollback frames throughout recovery and live operation;
   invalidate the affected handoff and recover through RPC before trusting a new
   boundary. This marker does not replace independent validator root, block-hash,
   or confirmation checks.

The boundary means RPC must cover through `height`, while the registered stream
covers subsequent events above it under that stream's confirmation policy. It is
**not** a promise that events at or below that height have already been sent; late
overlap events are allowed.
Do not interpret the highest event nonce or the existing `block` feed as this
boundary. Heights and hashes use each adapter's native units (including Solana
slots and Radix state versions); heights are decimal strings and addresses can
be 20 or 32 bytes.

A domain without a healthy, valid retained checkpoint receives
`{"type":"live_start_unavailable","domain":1,"eventTypes":["dispatch"],"reason":"No healthy live-start scraper checkpoint"}`.
Custom unavailable frames also carry `confirmations`. Keep RPC indexing for that
stream. A malformed checkpoint or contract identity affects only that domain;
other domains stay connected. A database query failure closes the socket.
Reconnects require a fresh boundary and RPC gap recovery; never reuse the prior
connection's marker. A missing marker, disconnect, or failed verification must
not authorize takeover. Existing clients must ignore unknown frame types.

Event delivery is independent per event type and can begin in the middle of a
block range or page sequence. A `subscribed` acknowledgement alone is not a
shared block boundary or a completeness guarantee. Buffer from `subscribed` and
use `live_start` as the explicit RPC recovery target for every required stream,
including gas payments. Dispatch/Merkle sequence agreement alone cannot establish
gas completeness. If a boundary is unavailable, keep RPC indexing for that stream.

### Per-domain confirmations

Set `confirmationsByDomain` on the subscription to apply a confirmation count to
all requested event types for a domain. Check `ready.confirmations.byDomain` for
server support and verify the echoed map in `subscribed` before relying on it;
older proxies can ignore an unknown map and stream canonical data instead:

```json
{
  "type": "subscribe",
  "confirmationsByDomain": {
    "1": 12,
    "1399811149": 32
  },
  "streams": [
    {
      "eventType": "dispatch",
      "domains": [1, 56, 1399811149],
      "confirmations": 2
    },
    { "eventType": "delivery", "domains": [1, 56, 1399811149] },
    { "eventType": "gas_payment", "domains": [1, 56, 1399811149] },
    { "eventType": "merkle_tree_insertion", "domains": [1, 56, 1399811149] }
  ]
}
```

For each event type and domain, the effective policy is:

1. `confirmationsByDomain[domain]`, when supplied (including `0`).
2. The legacy stream's `confirmations`, when supplied.
3. The scraper's configured canonical confirmation/finality policy.

In this example, Ethereum uses 12 confirmations and Solana uses 32 slots for all
four event types. Domain 56 uses 2 confirmations for dispatch and its configured
canonical policy for the other event types. Legacy per-event confirmations remain
supported during agent migration.

The map requires explicit domains on event streams; its keys do not subscribe to
additional domains. Unused keys are rejected, including keys used only by `blocks`.
Counts must be integers from 0 through 1,000 and keys must be uint32 domain IDs.
Custom/advisory subscriptions allow at most 512 domains and a 10,000 domain-block
budget, using the largest requested count per domain and counting zero as one.
Canonical-only fleet subscriptions retain their existing domain capacity.
All agent streams are live-only; recover history through RPC.
`blocks` subscriptions still report raw indexed heads and ignore this map.
The `subscribed` response echoes the map alongside the original streams.
Legacy canonical subscriptions retain per-domain `live_start_unavailable` behavior
for missing checkpoints; other domains remain subscribed. An explicit custom
policy, including a domain override, requires near-head state for every affected
domain. A missing head rejects the whole subscription with close code 1008;
advisory zero-confirmation streams retain their existing canonical fallback.

All requested domain/count pairs, including advisory zero-confirmation pairs,
share one initial database snapshot per subscription. After setup, agents and
validators share domain/event-type ranges across policies within their own isolated route.
Rollbacks during setup refresh the snapshot; active rollbacks invalidate cached
rows before replacement events are published.
Canonical publication excludes overridden domains; the same event is not
also emitted at the configured default. Handoff boundaries and rollback frames
retain the effective numeric confirmation count. A domain can receive multiple
`live_start` frames, covering different event types and effective policies.

### Legacy per-event confirmations

To use a custom confirmation delay, provide both `confirmations` and explicit
`domains` on a stream:

```json
{
  "type": "subscribe",
  "streams": [{ "eventType": "dispatch", "domains": [1], "confirmations": 2 }]
}
```

Custom-confirmation eligibility is the minimum of indexed height and chain head
minus confirmations. `/agents` requires near-head state for every requested
custom domain.

Set `includeZeroConfirmations: true` on any event stream to also receive live
zero-confirmation events on the same connection. For example,
`{ "eventType": "dispatch", "domains": [1], "confirmations": 15, "includeZeroConfirmations": true }`
sends events with `confirmations: 0` and again at `confirmations: 15`.
The extra stream leaves canonical live delivery unchanged. At depth 0,
events are sent once. Rollback frames
identify the affected stream by `eventType` and `confirmations`.
Provisional Merkle event envelopes also include `blockHash`.
The extra stream is best-effort: domains without near-head state report an unavailable
boundary and are skipped until reconnect, without rejecting canonical live delivery. Explicit numeric
confirmation subscriptions still require near-head state for every requested domain.

Server frame types:

| `type`       | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `subscribed` | Echoes the normalized accepted stream configuration                              |
| `event`      | Protocol event with `eventType`, `domain`, `data`, and native sequence or row ID |
| `rollback`   | Custom-confirmation event range was invalidated by a reorg                       |
| `block`      | Current indexed block snapshot or update                                         |
| `pong`       | Response to `{ "type": "ping" }`                                                 |
| `error`      | Invalid subscription or stream failure                                           |

On `rollback`, undo or reload effects above `toHeight`; replacement events
follow. On disconnect, recover missing history through RPC before resuming
live processing.

## Data and consistency rules

- Canonical scraper rows use the scraper's configured finality.
- Custom confirmation data is provisional and can roll back.
- WebSocket streams provide live state only; recover historical state through RPC.
- GraphQL pagination observes committed rows at query time.
- Large integers are serialized as strings.
- Addresses and message IDs may be normalized to PostgreSQL bytea form
  (`\\x...`) on the wire.
- LISTEN/NOTIFY triggers reads; database rows remain the source of truth.
- The diagnostics database is optional and cannot block scraper-backed APIs.

## Configuration and deployment

Required and optional database settings:

| Variable                    | Purpose                                             |
| --------------------------- | --------------------------------------------------- |
| `DATABASE_URL`              | Scraper database primary; required for live streams |
| `DATABASE_READ_REPLICA_URL` | Optional GraphQL read replica                       |
| `DIAGNOSTICS_DATABASE_URL`  | Optional SELECT-only relayer diagnostics database   |

Startup validates the `scraper_head` table and its read privileges before
accepting traffic. Gas replay cursor tables and triggers are no longer required. The
diagnostics pool opens lazily; diagnostics downtime does not block startup.

See [config.ts](src/config.ts) for connection, request, buffering, and
rate limits.

The `hyperlane-node-services` image includes this service. The dedicated
`scraper-proxy` Helm release syncs database URLs through ExternalSecrets.
[mainnet3](../infra/config/environments/mainnet3/agent.ts) and
[testnet4](../infra/config/environments/testnet4/agent.ts) enable it. Image tags
live in [docker.ts](../infra/config/docker.ts).

Deploy from the repository root:

```sh
pnpm -C typescript/infra tsx scripts/agents/deploy-agents.ts \
  --environment mainnet3 --roles scraper-proxy
```

Use `testnet4` for testnet. When enabling the tunnel, supply the GCP secret
`{context}-{environment}-scraper-proxy-cloudflared-tunnel-token`. Route only
`/graphql*`, `/messages*`, and the exact `/validators` path publicly; keep `/agents`
cluster-only. Tunnel ingress is managed remotely in Cloudflare, not by this chart.

The configured SELECT-only Secret Manager values are
`hyperlane-mainnet-relayer-postgres-reader-url` for mainnet3 and
`hyperlane-testnet4-relayer-postgres-reader-url` for testnet4. Environments
without `scraperProxy.diagnosticsDatabaseSecret` leave diagnostics disabled.

## Development

With workspace dependencies installed and built:

```sh
cd typescript/scraper-proxy
cp .env.example .env
# Set DATABASE_URL to a scraper database read-only URL.
pnpm dev
```

The service listens on `http://localhost:8383`.

Useful commands:

```sh
pnpm test
pnpm debug:websocket --help
```

Set `SCRAPER_TEST_DATABASE_URL` to include PostgreSQL projection tests. Set
`DIAGNOSTICS_TEST_DATABASE_URL` to run diagnostic ordering tests against a
session-local temporary table:

```sh
DIAGNOSTICS_TEST_DATABASE_URL='postgresql://...' \
pnpm exec node --import tsx --test src/diagnostics/*.test.ts
```

The test requires `TEMP` permission and does not modify existing relayer data.

Implementation entry points:

| Area                                | Source                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Startup and shutdown                | [main.ts](src/main.ts)                                                                                                       |
| GraphQL schema and SQL projection   | [scraperdb-schema.graphql](src/graphql/scraperdb-schema.graphql), [scraperdb.service.ts](src/scraperdb/scraperdb.service.ts) |
| WebSocket server                    | [event-websocket.ts](src/live/event-websocket.ts)                                                                            |
| Wire validation                     | [protocol.ts](src/live/protocol.ts)                                                                                          |
| Custom confirmations and rollbacks  | [confirmation-stream.ts](src/live/confirmation-stream.ts)                                                                    |
| Diagnostics reduction and streaming | [diagnostics](src/diagnostics)                                                                                               |
