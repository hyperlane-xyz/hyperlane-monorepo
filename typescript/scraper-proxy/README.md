# Scraper proxy

Exposes the scraper PostgreSQL database through GraphQL at `/graphql`, protocol
events for agents at `/agents`, and enriched message updates at `/messages`.

## Deployment

The proxy is bundled into `hyperlane-node-services` as `scraper-proxy`. The
mainnet scraper Helm release runs it next to the scraper with a `cloudflared`
sidecar. The existing scraper database secret supplies `DATABASE_URL`.

Before enabling the deployment:

1. Build and publish `hyperlane-node-services`, then set the immutable tag in
   `mainnetDockerTags.scraperProxy`.
2. Create a remotely managed Cloudflare tunnel whose public hostname routes
   only `/graphql*` and `/messages*` to `http://localhost:8383`, followed by a
   catch-all HTTP 404 rule. Configure Cloudflare per-client rate limits for
   both public routes.
3. Store its token in GCP Secret Manager as
   `hyperlane-mainnet3-scraper-proxy-cloudflared-tunnel-token`.
4. Set `scraper.proxy.enabled` to `true` in the mainnet agent config.
5. Deploy the scraper role:

   ```sh
   pnpm -C typescript/infra tsx scripts/agents/deploy-agents.ts \
     --environment mainnet3 --roles scraper
   ```

The public endpoints are then:

- `https://<hostname>/graphql`
- `wss://<hostname>/messages`

`/agents` is not public. Pods use
`ws://<scraper-proxy-service>.<namespace>.svc:8383/agents` through the
cluster-only Kubernetes Service.

`/messages` automatically streams `message_upsert` events containing normalized
`message_view` rows. It does not emit gas payments or Merkle tree insertions.

Historical WebSocket catch-up is disabled by default. Set
`scraper.proxy.historyEnabled` to `true` only when the database is provisioned
for catch-up traffic.

Outbound WebSocket buffering is limited to 1 MiB per socket and 32 MiB across
all sockets. GraphQL is limited to 25 concurrent requests; Cloudflare owns
public per-client request-rate enforcement.
