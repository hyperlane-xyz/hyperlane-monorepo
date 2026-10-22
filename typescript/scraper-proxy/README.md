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

Startup checks the scraper schema and notification triggers before accepting
traffic. `DATABASE_READ_REPLICA_URL` optionally routes GraphQL reads to a replica;
live streams always use the primary. See [config.ts](src/config.ts) for all settings
and limits. Set `SCRAPER_TEST_DATABASE_URL` to include PostgreSQL projection tests
(session-local temporary tables). Use `pnpm debug:websocket --help` for socket diagnostics.

## Project map

Paths below are relative to `src/`. [main.ts](src/main.ts) loads configuration,
creates the database and servers, and owns startup/shutdown. Sockets stop before
pools close; [db.service.ts](src/db/db.service.ts) owns pools, timeouts, schema
checks, and LISTEN reconnects.

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
