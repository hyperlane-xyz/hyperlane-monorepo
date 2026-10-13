# Scraper proxy

Exposes the scraper PostgreSQL database through GraphQL at `/graphql`, protocol
events for agents at `/agents`, enriched message updates at `/messages`, and
Prometheus metrics at `/metrics`.

## Live confirmations and rollback

Canonical streams keep their existing behavior and historical cursors. To select
a delay on `/agents`, subscribe with, for example:

```json
{
  "type": "subscribe",
  "streams": [{ "eventType": "dispatch", "domains": [1], "confirmations": 2 }]
}
```

Explorer uses `/messages?confirmations=2&domains=1,42161`. Custom streams are
live-only: they start at the current eligible height and reject historical cursors.
On `/messages`, domains with near-head scraper state use the requested delay;
other requested domains continue sending canonical updates on the same socket.
The `ready` frame lists `customDomains` and `canonicalDomains`. The requested
confirmation count applies **only** to `customDomains`; canonical domains use
their existing scraper finality. This split is negotiated again on reconnect.
Agent custom streams still require near-head state for every requested domain.
Reconnecting starts a new live subscription; clients must reload their snapshot
after a gap.

Eligibility is `min(indexed height, head height - confirmations)`. The delay uses
the chain's native height (blocks, slots, or state versions). Events carry their
height; Explorer range upserts carry the snapshot height. A fork emits
`{"type":"rollback","domain":1,"fromHeight":"10","toHeight":"9","confirmations":2}`
(`/agents` also includes `eventType`). Clients undo or reload effects above
`toHeight`; replacement rows follow on the same socket. `fromHeight` conservatively
includes the range being read, even if only part of it was sent.

The proxy has one sequential, paginated reader per custom stream. It uses the
existing socket backpressure and interrupts stale reads on rollback; there is
no custom historical replay or pending-event buffer. Explorer metadata updates
are coalesced by message ID and read by that same worker.

Explorer's `ExplorerEventsProvider` requests zero confirmations, clears its
provisional overlay and retained message subscriptions on rollback, and refreshes
the canonical GraphQL snapshot on rollback/reconnect. It accepts canonical and
custom upserts on the same connection; no separate socket is needed per chain.

Run `pnpm test` for protocol/socket regressions. Set `SCRAPER_TEST_DATABASE_URL`
to also run the PostgreSQL projection regression (session-local temporary tables
only), including mixed-chain confirmation boundaries and legacy-message updates.

## Deployment

The proxy is bundled into `hyperlane-node-services` as `scraper-proxy`. The
dedicated scraper-proxy Helm release runs it with a `cloudflared` sidecar. Its
ExternalSecret reads the scraper database's read-only URL into `DATABASE_URL`.

Before enabling the deployment:

1. Build and publish `hyperlane-node-services`, then set the immutable tag in
   `mainnetDockerTags.scraperProxy`.
2. Create a remotely managed Cloudflare tunnel whose public hostname routes
   only `/graphql*` and `/messages*` to `http://localhost:8383`, followed by a
   catch-all HTTP 404 rule. Configure Cloudflare per-client rate limits for
   both public routes.
3. Store its token in GCP Secret Manager as
   `hyperlane-mainnet3-scraper-proxy-cloudflared-tunnel-token`.
4. Set `scraperProxy.enabled` to `true` in the mainnet agent config.
5. Deploy the scraper-proxy role:

   ```sh
   pnpm -C typescript/infra tsx scripts/agents/deploy-agents.ts \
     --environment mainnet3 --roles scraper-proxy
   ```

The public endpoints are then:

- `https://<hostname>/graphql`
- `wss://<hostname>/messages`

`/agents` is not public. Pods use
`ws://<scraper-proxy-service>.<namespace>.svc:8383/agents` through the
cluster-only Kubernetes Service.

`/messages` automatically streams `message_upsert` events containing normalized
`message_view` rows. It does not emit gas payments or Merkle tree insertions.
Production requests must arrive through Cloudflare with a valid
`CF-Connecting-IP` header; at most five connections are accepted per client IP.

The private `/agents` endpoint always supports historical WebSocket catch-up.
Replay is paginated without a total row limit. Concurrent catch-ups, session
duration, database query timeouts, and outbound buffering remain bounded.

Outbound WebSocket buffering is limited to 1 MiB per socket and 32 MiB across
all sockets. GraphQL is limited to 25 concurrent requests; Cloudflare owns
public per-client request-rate enforcement.

`/metrics` reports GraphQL request usage and latency; WebSocket connections,
subscriptions, catch-ups, notification queues, outbound buffering, limits and
rejections; database pool pressure and listener readiness; and standard Node.js
process metrics.
