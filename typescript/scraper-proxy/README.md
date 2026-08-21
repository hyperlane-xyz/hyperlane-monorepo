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

`/messages` automatically streams `message_upsert` events containing normalized
`message_view` rows. It does not emit gas payments or Merkle tree insertions.
Production requests must arrive through Cloudflare with a valid
`CF-Connecting-IP` header; at most five connections are accepted per client IP.

The private `/agents` endpoint always supports historical WebSocket catch-up.

Outbound WebSocket buffering is limited to 1 MiB per socket and 32 MiB across
all sockets. GraphQL is limited to 25 concurrent requests; Cloudflare owns
public per-client request-rate enforcement.

`/metrics` reports GraphQL request usage and latency; WebSocket connections,
subscriptions, catch-ups, notification queues, outbound buffering, limits and
rejections; database pool pressure and listener readiness; and standard Node.js
process metrics.
