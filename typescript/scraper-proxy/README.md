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

| Interface           | Use it for                                                                   | Delivery model                      | Intended clients                  |
| ------------------- | ---------------------------------------------------------------------------- | ----------------------------------- | --------------------------------- |
| `GET/POST /graphql` | Historical queries, pagination, message snapshots, diagnostic history        | Request/response                    | Explorer, Nexus, services         |
| `WS /messages`      | Enriched message updates, selected message IDs, block heads, diagnostics     | Server pushes after URL negotiation | Explorer, Nexus, public consumers |
| `WS /agents`        | Raw protocol events, cursor replay, canonical or custom-confirmation streams | Client sends a subscription         | Internal agents and indexers      |
| `GET /metrics`      | Request, database, WebSocket, queue, and process metrics                     | Prometheus scrape                   | Monitoring                        |

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
  message_view(order_by: [{ send_occurred_at: desc }], limit: 25) {
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
Custom snapshots support 0–1,000 confirmations, reject non-zero offsets, and cap
the affected event scan at 10,000 rows. Narrow large provisional queries by
`msg_id`.

For a combined live list:

1. Page canonical history normally.
2. Query provisional rows with `confirmations: 0` and
   `where: {is_provisional: {_eq: true}}`.
3. Merge by `msg_id`, prefer provisional fields, and sort by send time.

Only canonical pages should be used as durable history cursors.

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

`messageIds` accepts at most 50 IDs. It filters ordinary message updates before
database enrichment. Diagnostics requires between 1 and 50 explicit IDs.

Production `/messages` requests must include a valid `CF-Connecting-IP` header.
At most five connections are allowed per client IP.

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

## Agent WebSocket: `/agents`

`/agents` is the private, cursor-aware protocol stream for agents and internal
indexers. Keep it cluster-only:

```text
ws://scraper-proxy.<namespace>.svc:8383/agents
```

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
  "historicalStreaming": true,
  "confirmations": { "unit": "blocks", "liveOnly": true },
  "streamCursorVersions": { "gas_payment": 3 }
}
```

The client then sends one subscription containing each desired event type at
most once:

```json
{
  "type": "subscribe",
  "streams": [
    {
      "eventType": "dispatch",
      "cursors": [
        {
          "domain": 1,
          "address": "0x0000000000000000000000000000000000000001",
          "afterSequence": "42"
        }
      ]
    },
    {
      "eventType": "gas_payment",
      "streamCursorVersion": 3,
      "cursors": [
        {
          "domain": 1,
          "address": "0x0000000000000000000000000000000000000002",
          "afterStreamCursor": "100"
        }
      ]
    },
    { "eventType": "delivery" },
    { "eventType": "blocks", "domains": [1, 42161] }
  ]
}
```

### Available streams

| `eventType`             | Data                                                                                 | Historical cursor                           |
| ----------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| `dispatch`              | Raw message dispatch, origin/destination, mailbox, sender, recipient, body, tx/block | Per mailbox `afterSequence` (message nonce) |
| `delivery`              | Delivered message ID, destination mailbox/domain, destination transaction            | Live only                                   |
| `gas_payment`           | Message ID, payment, gas amount, IGP, origin/destination, tx/log metadata            | Version 3 per-IGP `afterStreamCursor`       |
| `merkle_tree_insertion` | Message ID, Merkle tree hook, leaf index, domain, block                              | Per hook `afterSequence` (leaf index)       |
| `blocks`                | Indexed block height/hash and observed chain head                                    | Live snapshot and changes only              |

Without a cursor, event streams begin live. With cursors, the proxy replays
history, emits `caught_up`, and then hands off to live delivery without gaps.
Cursor values and row IDs are decimal strings.

`allowReplay: true` permits a sequence cursor ahead of current scraper history
to restart from the current end. Gas-payment cursors require
`streamCursorVersion: 3`; physical database row IDs are not valid cursors.

To use a custom confirmation delay, provide both `confirmations` and explicit
`domains` on a stream:

```json
{
  "type": "subscribe",
  "streams": [{ "eventType": "dispatch", "domains": [1], "confirmations": 2 }]
}
```

Custom-confirmation streams are live-only and reject cursors. Eligibility is the
minimum of indexed height and chain head minus confirmations. `/agents` requires
near-head state for every requested custom domain and does not support custom
confirmation delays for `delivery`.

Server frame types:

| `type`       | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `subscribed` | Echoes the normalized accepted stream configuration                             |
| `event`      | Protocol event with `eventType`, `domain`, `data`, and applicable cursor fields |
| `caught_up`  | Historical cursor replay reached the advertised boundary                        |
| `rollback`   | Custom-confirmation event range was invalidated by a reorg                      |
| `block`      | Current indexed block snapshot or update                                        |
| `pong`       | Response to `{ "type": "ping" }`                                                |
| `error`      | Invalid subscription or stream failure                                          |

On `rollback`, undo or reload effects above `toHeight`; replacement events
follow. Historical replay is bounded by time and pending-event limits, so persist
cursor progress and reconnect when necessary.

## Data and consistency rules

- Canonical scraper rows use the scraper's configured finality.
- Custom confirmation data is provisional and can roll back.
- WebSocket streams provide live state and bounded replay, not a frozen export.
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

Startup validates scraper stream cursor schema, read privileges, and the
`gas_payment_stream_cursor_assign` trigger before accepting traffic. The
diagnostics pool opens lazily; diagnostics downtime does not block startup.

See [config.ts](src/config.ts) for connection, request, replay, buffering, and
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
`/graphql*` and `/messages*` publicly; keep `/agents` cluster-only.

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
| Historical agent replay             | [agent-subscription.ts](src/live/agent-subscription.ts)                                                                      |
| Custom confirmations and rollbacks  | [confirmation-stream.ts](src/live/confirmation-stream.ts)                                                                    |
| Diagnostics reduction and streaming | [diagnostics](src/diagnostics)                                                                                               |
