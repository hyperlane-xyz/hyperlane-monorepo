# Scraper proxy

Read-only access to the scraper PostgreSQL database:

| Endpoint    | Purpose                                                   |
| ----------- | --------------------------------------------------------- |
| `/graphql`  | Queries, pagination, and optional confirmation snapshots  |
| `/agents`   | Private protocol events with cursor-based catch-up        |
| `/messages` | Public WebSocket feed of enriched `message_upsert` rows   |
| `/metrics`  | Prometheus request, socket, database, and process metrics |

## Development

With workspace dependencies installed and built, run from this directory:

```sh
cp .env.example .env # Set DATABASE_URL to the scraper database's read-only URL.
pnpm dev            # http://localhost:8383
pnpm test
```

Startup checks the stream cursor schema, read privileges, and the
`gas_payment_stream_cursor_assign` trigger before accepting traffic. `DATABASE_READ_REPLICA_URL` optionally routes GraphQL reads to a replica;
live streams always use the primary. See [config.ts](src/config.ts) for all settings
and limits. Set `SCRAPER_TEST_DATABASE_URL` to include PostgreSQL projection tests
(session-local temporary tables). Use `pnpm debug:websocket --help` for socket diagnostics.

## Project map

Paths below are relative to `src/`. [main.ts](src/main.ts) loads configuration,
creates the database and servers, and owns startup/shutdown. Sockets stop before
pools close; [db.service.ts](src/db/db.service.ts) owns pools, timeouts, schema
checks, and LISTEN connections; `live/event-websocket.ts` owns reconnects.

```text
main.ts
├── module.ts → Fastify + CORS → /metrics
│   └── scraperdb/graphql.ts → Mercurius + request lifecycle → /graphql
│       ├── request-compatibility.ts + validation.ts → AST normalization and limits
│       ├── response-cache.ts + cache-config.ts → @cached responses, TTL, refresh
│       └── resolver-map.ts + scalars.ts
│           └── scraperdb.service.ts → sql.ts → DbService.query → primary or replica
└── live/event-websocket.ts → /agents, /messages
    ├── protocol.ts + websocket-data.ts → wire parsing and negotiation
    ├── agent-subscription.ts → cursor positions, replay, and live handoff
    ├── notification-worker.ts → batched event, message, and head drains
    ├── confirmation-stream.ts → custom frontiers, enrichment, rollback
    └── event-store.ts → DbService.queryLive → primary
        └── provisional-message.ts ← also used by GraphQL snapshots
```

[Row types and root queries](src/graphql/scraperdb-schema.graphql) are the source
for generated filters, ordering, cursors, and SQL column allowlists. Add fields
there, then update their database projections. GraphQL hooks stay scoped to
`/graphql`; cache hits undergo request validation. Shared provisional SQL keeps
GraphQL snapshots and WebSocket updates on the same confirmation frontier.
Tests sit beside their modules; HTTP and socket integration tests cover lifecycles.

## Stream and snapshot contracts

Canonical streams support historical cursors. For a custom confirmation delay,
send this on `/agents`, or connect to `/messages?confirmations=2&domains=1`:

```json
{
  "type": "subscribe",
  "streams": [{ "eventType": "dispatch", "domains": [1], "confirmations": 2 }]
}
```

- Custom streams are live-only, require explicit domains, and reject cursors.
  Eligibility is `min(indexed height, head height - confirmations)`, using native
  chain heights (for example, Sealevel slots). Reload snapshots after reconnects.
- `/messages` reports `customDomains` and `canonicalDomains` in `ready`. Only
  domains with near-head state use the requested delay; others keep canonical
  finality. `/agents` requires near-head state for every custom domain and rejects
  custom `delivery` streams.
- On `rollback`, undo or reload effects above `toHeight`; replacement rows follow.
  Agent rollback frames also identify `eventType`.
- For block heads, add `{"eventType":"blocks","domains":[1]}` to agent streams,
  or use `/messages?blocks=true`. Message domain filtering requires both
  `confirmations` and `domains`; omitted block domains select all near-head domains.
  A snapshot follows `subscribed`/`ready`, then changed heads. `height`/`hash`
  identify the indexed block; `headHeight` is the observed tip. Heights are decimal
  strings. Updates may skip or decrease heights: replace the current head.
  Block subscriptions accept neither cursors nor confirmation delays.

GraphQL `message_view(confirmations: N)` uses the same frontier; omitted/null
confirmations and domains without near-head state retain canonical finality.
Custom snapshots accept 0–1,000 confirmations, reject cursors/non-zero offsets,
and cap affected events at 10,000. Narrow by `msg_id` or use canonical history
if that cap is exceeded. A failed snapshot returns `null` plus an error for its
alias; other aliases remain available.

For a combined live list, fetch canonical history separately from provisional
rows (`confirmations: 0`, `where: {is_provisional: {_eq: true}}`). Merge by `msg_id`,
prefer provisional fields, and sort by send time. Raw and canonical IDs use
separate sequences: only canonical pages supply history cursors.
`origin_block_height` supports confirmation tracking; `message_view_aggregate`
remains canonical-only.

## Deployment

The `hyperlane-node-services` image includes this service. The dedicated
`scraper-proxy` Helm release loads primary and replica URLs from ExternalSecrets.
Both [mainnet3](../infra/config/environments/mainnet3/agent.ts) and
[testnet4](../infra/config/environments/testnet4/agent.ts) enable it; testnet disables
the optional `cloudflared` sidecar. Image tags live in [docker.ts](../infra/config/docker.ts).

```sh
pnpm -C typescript/infra tsx scripts/agents/deploy-agents.ts \
  --environment mainnet3 --roles scraper-proxy
```

Run that command from the repository root; use `testnet4` for testnet.
When enabling a tunnel, supply the GCP secret
`{context}-{environment}-scraper-proxy-cloudflared-tunnel-token`. Configure its
public hostname to route only `/graphql*` and `/messages*` to
`http://localhost:8383`, with per-client rate limits and a catch-all HTTP 404.
Keep `/agents` cluster-only at `ws://scraper-proxy.<namespace>.svc:8383/agents`.
Production `/messages` requests require a valid `CF-Connecting-IP` header and
allow at most five connections per client IP.

## Optional relayer diagnostics

Set `DIAGNOSTICS_DATABASE_URL` to the **shared relayer diagnostics database**, using
an account with `SELECT` on `public.message_activity`. This is separate from
`DATABASE_URL` (scraper DB). The read-only pool is lazy and limited to three
connections, with one additional PostgreSQL notification listener;
an unavailable diagnostics DB does not block normal GraphQL or message streams.
No new tables or migrations are needed in the proxy. Mainnet3 sets
`scraperProxy.diagnosticsDatabaseSecret` to the SELECT-only GCP Secret Manager
secret `hyperlane-mainnet-relayer-postgres-reader-url`. The Helm chart syncs that
value through ExternalSecrets and injects `DIAGNOSTICS_DATABASE_URL` into the
proxy container.
Environments without `diagnosticsDatabaseSecret` leave diagnostics disabled.

### GraphQL history and recent status

```graphql
query {
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
        verification
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

History is newest first, with an exclusive `before_id` cursor; use
`next_before_id` for older pages. Limits are 1–500 (default 100). IDs are strings
so JavaScript does not lose bigint precision. Activity JSON is the relayer's
sanitized, versioned event payload. No secrets, signatures, or extra RPC calls are
introduced by the proxy. Errors use `DIAGNOSTICS_UNAVAILABLE` when disabled/down.

Progress uses explicit GraphQL object types and the shared TypeScript contract in
`src/diagnostics/types.ts`. WebSocket snapshots carry the same fields and
`version: 1`; raw JSON is confined to activity history. Phases and verification
outcomes are enums. Missing/null progress fields mean unobserved, not zero or
success. Unknown verification outcomes map to `unknown`. Retry reasons are stable
string codes; tagged reasons become e.g. `ApplicationReport.ZeroAmount`, with
unrecognized structures reported as `unknown` and preserved in raw history.

`message_diagnostics` reduces the most recent 100 activities (oldest first) into
per-relayer observations: phase, retry reason/deadline, failures, and per-ISM
thresholds, verified module counts, signature collection and offchain reads.
`partial: true` means older context was omitted; history remains pageable.
Signature counts are **required threshold**, not validator-set size. Counts from
different relayers, collection attempts, checkpoint indices or roots are never
added together. Unobserved counts stay absent, not zero. Nested ISMs retain their
routing/aggregation relationships; there is no invented global signature total.
Each module includes its last observation time. A new preparation attempt clears prior module state; a new metadata attempt
clears that module's prior verification/signature state. Retry deadlines clear
when preparation resumes or delivery completes.

### WebSocket

Opt in on the existing Explorer/Nexus socket:

```text
/messages?diagnostics=true&messageIds=0xMESSAGE_ID,0xOTHER_MESSAGE_ID
```

`messageIds` filters ordinary message updates too, before enrichment, and works
without diagnostics. Omit it for the global Explorer feed; explicitly empty
`messageIds=` requests no message updates (useful for block heads while discovering
IDs). The `ready` frame echoes normalized IDs. Reconnect with a new list when the
watched set changes.
This works alongside `blocks=true` and custom confirmations. Diagnostics requires
1–50 explicit message IDs; ordinary `/messages` clients incur no diagnostics DB
reads. Committed relayer inserts notify the proxy with the affected message ID;
notifications are briefly coalesced and only affected watched IDs are read
(maximum 200 unique message IDs globally and 50 per IP across connections).
New subscriptions read their initial IDs once. There is no periodic polling.
Because PostgreSQL notifications are not durable, a listener reconnect refreshes
all watched IDs once to repair its gap. Existing `message_upsert` frames are unchanged.
Diagnostics bypass the normal message queue and are skipped when normal updates
are queued or either outbound byte budget would exceed half its limit. Skipped
snapshots retry only their affected IDs; only successful writes suppress repeats.
Additional negotiated event types:

- `diagnostics`: `{ type, data: { version, message_id, partial, activities, relayers } }`.
  Initial/reconnect snapshot, then changes only. Activities are oldest first.
  **Replace** the recent snapshot; do not append the whole frame as new history.
- `diagnostics_unavailable`: `{ type, message_ids, message }`. Retain the last
  snapshot but mark it stale. The server retries and sends fresh snapshots when
  reads recover, without disconnecting the underlying message stream. When
  diagnostics are unconfigured or subscription capacity is exhausted, normal
  message updates still work; reconnect to renegotiate diagnostics later.

Snapshots re-read the indexed recent window rather than assuming identity IDs
commit in order across relayers. This is a best-effort current view, **not a
lossless event stream**; use GraphQL for older history. Pagination also describes
committed rows at read time, not a frozen history export.

Diagnostic `delivered` is a relayer observation. Use scraper `is_delivered` for
authoritative on-chain delivery, and never infer verification from collected
signatures, metadata success, absent events, or a validator read failure. Missing
events/unknown versions mean incomplete knowledge. No background signature reads
or ISM verification are performed by this service.

To exercise numeric ordering against PostgreSQL:

```sh
DIAGNOSTICS_TEST_DATABASE_URL='postgresql://...' \
pnpm exec node --import tsx --test src/diagnostics/*.test.ts
```

The test uses a session-local temporary table (requiring `TEMP` permission) and
does not modify existing relayer data.
