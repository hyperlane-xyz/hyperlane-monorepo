# Scraper proxy

Exposes the scraper PostgreSQL database through GraphQL at `/graphql`, protocol
events for agents at `/agents`, enriched message updates at `/messages`, and
Prometheus metrics at `/metrics`.

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

`/messages` streams `message_upsert` events containing normalized `message_view`
rows. With no query parameters, it retains the canonical-confirmation behavior.
To opt into another depth, connect with explicit domains, for example
`/messages?confirmations=0&domains=1,42161`. Custom-confirmation upserts also
include top-level `confirmations`, `domain`, and `height` fields describing the
source frontier; key provisional messages by `data.msg_id`. It does not emit raw
gas payments or Merkle tree insertions. Production requests must arrive through
Cloudflare with a valid `CF-Connecting-IP` header; at most five connections are
accepted per client IP.

The private `/agents` endpoint always supports historical WebSocket catch-up.
Replay is paginated without a total row limit. Concurrent catch-ups, session
duration, database query timeouts, and outbound buffering remain bounded.

Subscribers may set `confirmations` on a stream to receive events once they are
that many chain heights behind the observed head. This works for every protocol
indexed by the near-head scraper. Custom confirmations require an explicit
`domains` list (or sequence cursors that imply one). Example:

```json
{
  "type": "subscribe",
  "streams": [
    {
      "eventType": "dispatch",
      "domains": [1, 42161],
      "confirmations": 12
    }
  ]
}
```

Gas-payment cursors cannot be combined with custom confirmations because their
durable cursor is assigned only at the scraper's canonical confirmation
frontier. Non-cursored gas-payment streams support custom confirmations.

Custom-confirmation `/agents` and `/messages` subscribers receive a `rollback`
control event when a fork lowers the indexed frontier:

```json
{
  "type": "rollback",
  "confirmations": 0,
  "domain": 1,
  "fromHeight": "19400001",
  "toHeight": "19400000"
}
```

`/agents` also includes `eventType`. The socket stays open. The subscriber must
undo or reload effects from that domain above `toHeight`; replacement canonical
events/upserts are then replayed as indexing advances again. For `/messages`, a
rollback can affect delivery or payment fields on messages originating on a
different domain, so use the top-level source `domain` and `height`, not only
`data.origin_domain_id`, when retaining rollback history. Canonically confirmed
history is immutable; a fork crossing it halts the scraper instead of emitting
a rollback.

Outbound WebSocket buffering is limited to 1 MiB per socket and 32 MiB across
all sockets. GraphQL is limited to 25 concurrent requests; Cloudflare owns
public per-client request-rate enforcement.

`/metrics` reports GraphQL request usage and latency; WebSocket connections,
subscriptions, catch-ups, notification queues, outbound buffering, limits and
rejections; database pool pressure and listener readiness; and standard Node.js
process metrics.
