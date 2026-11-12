## OffchainLookup server

# CCIP-Server (OffchainLookup)

A lightweight Fastify server for CCIP Read/Write commitments, using Zod validation and Prisma for persistence.

## Prerequisites

- Node.js >=20
- pnpm or npm
- SQLite (for local development)
- A GCP (or other) SQL database URL for production

## Setup

1. **Install dependencies**

   ```bash
   cd typescript/ccip-server
   pnpm install    # or `npm install`
   ```

2. **Configure environment variables**  
   Copy the example and edit as needed:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` for local development:

   ```env
   # Use SQLite file for dev
   DATABASE_URL="file:./dev.db"

   # Optional: override default registries (comma-separated)
   REGISTRY_URI="https://raw.githubusercontent.com/hyperlane-xyz/registry/main"
   ```

   For production, set `DATABASE_URL` to your hosted SQL (Postgres/MySQL) connection string, and point `REGISTRY_URI` at your private registry(s).

3. **Generate Prisma client & run migrations**

   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   ```

4. **(Optional) Launch Prisma Studio**
   ```bash
   npm run prisma:studio
   ```
   Browse and inspect the SQLite file at `http://localhost:5555`.

## Running the Server

- **Development (auto-reload)**

  ```bash
  pnpm dev     # runs `tsx watch src/server.ts`
  ```

- **Production**

  ```bash
  # Apply migrations without prompts
  NODE_ENV=production \
  DATABASE_URL="<YOUR_PROD_URL>" \
    npx prisma migrate deploy

  # Start the compiled server
  NODE_ENV=production pnpm start
  ```

## API Routes

Commitment calldata reads require signed requests from a configured service address.
See [CCS authentication and rollout](./CCS_AUTH.md) for EVM signing on both EVM/SVM reads, whitelist
configuration, and compatibility with the existing EVM reveal endpoint.
`GET /calldata/:commitment` is disabled by default while the Sealevel reveal flow is
redesigned; set `CCS_CALLDATA_LOOKUP_ENABLED=true` to register it.

- `POST /calls`  
  Submit a new commitment payload. Validated via Zod; persists to the database.

  Config-based registration defaults to `interchainAccountRouter`. When using
  another deployment, supply `localRouter` (origin) and `routerOverride`
  (destination), for example the registry's `interchainAccountRouterV3` pair.
  Alternatively, supply `commitmentDispatchTx` using the legacy receipt-based
  registration shape. Compare the response's `ica` with the intended account.

- `POST /getCallsFromRevealMessage`
  CCIP-Read endpoint (uses ABI handler) to fetch & re-encode calls for a reveal message.

  The relayer must send `origin_tx_hash`, the transaction that dispatched the
  reveal. Calls are resolved from the commitment dispatched alongside the
  reveal. The server checks that

  - the reveal's origin is the stored commitment's origin,
  - the reveal was dispatched between ICA routers from the registry
    (`interchainAccountRouter` and `interchainAccountRouterV3`), and
  - the reveal is in the hinted transaction's mailbox events, with the
    commitment dispatched before it, and the ICA the dispatched routers derive
    for that commitment, or the ICA that any registry router version derives
    for the same owner and user salt, equals the stored ICA. The latter covers
    registrations made without router overrides.

  The ICA of the dispatched router pair is served, which can differ from the
  stored one. Reads do not modify stored commitments. A reveal that fails these
  checks gets HTTP 403. A missing or null hash, a missing receipt, a failing
  RPC, or a candidate ICA whose chain read failed (when none of the others
  match) get HTTP 500 so the relayer retries; malformed hash strings get 400.
  A candidate the chain answers as underivable (e.g. a router without salted
  accounts) does not match. For a destination that lists only
  `interchainAccountRouterV3`, candidates are derived from that router.
  Existing records with incorrect addresses still need a one-time database
  repair for `GET /calls/:commitment`. Re-registration must identify the same
  router pair: stale config that derives a different ICA still returns 409. A
  separate ICA router deployment is only served if the registry CCS reads lists
  its routers (otherwise run its own CCS). CCS fails to start if that registry
  lists no ICA routers, or lists a chain with ICA routers but no mailbox. Origin
  mailboxes are read from the registry addresses.

### Wormhole VAA lookup

Enable the module with `ENABLED_MODULES=wormhole` and configure:

```env
HYPERLANE_EXPLORER_URL=https://explorer.hyperlane.xyz/graphql
# Wormholescan-compatible base URLs, queried in parallel.
WORMHOLE_VAA_URLS=https://api.wormholescan.io
# Optional: WORMHOLE_VAA_TIMEOUT_MS, WORMHOLE_VAA_MAX_BYTES,
# WORMHOLE_VAA_MAX_ATTEMPTS, WORMHOLE_VAA_RETRY_DELAY_MS
```

The CCIP `sender` identifies the destination combined hook/ISM. The server
discovers its origin peer, Wormhole Core contracts, and Wormhole chain IDs from
reciprocal on-chain enrollment. RPC URLs come from the Hyperlane registry
selected by `REGISTRY_URI`; no deployment-address mapping is required. The
module exposes the CCIP-read endpoints:

- `GET /wormhole/getWormholeVaa/:sender/:callData.json`
- `POST /wormhole/getWormholeVaa`

The service finds the one Core publication for the message in the origin
receipt and queries every endpoint in `WORMHOLE_VAA_URLS` in parallel, returning
the first VAA whose locator, emitter, nonce, consistency level and payload
match the publication. While any endpoint reports the VAA as pending, it
retries every endpoint with backoff, up to `WORMHOLE_VAA_MAX_ATTEMPTS` rounds.
If no endpoint matches, the request fails with a pending error when any endpoint
had no VAA yet, and otherwise with an error listing each endpoint's failure. The destination contract repeats all security checks; the server
is untrusted availability infrastructure.

### LayerZero V2 packet lookup

Enable the module with `ENABLED_MODULES=layerzero` and configure:

```env
HYPERLANE_EXPLORER_URL=https://explorer.hyperlane.xyz/graphql
```

The CCIP `sender` identifies the destination combined hook/ISM. The server
discovers its origin peer, Mailboxes, Endpoint V2 contracts, and LayerZero
domain IDs from reciprocal on-chain enrollment. RPC URLs come from the
Hyperlane registry selected by `REGISTRY_URI`; no deployment-address mapping is
required. The module exposes the CCIP-read endpoints:

- `GET /layerzero/getLayerZeroPacket/:sender/:callData.json`
- `POST /layerzero/getLayerZeroPacket`

The service finds the exact `PacketSent` event in the Hyperlane dispatch
receipt, validates every pathway and payload field, resolves the current receive
library from Endpoint state, and simulates `commitVerification`
before returning `(receiveLibrary, packet)`.
The destination contract repeats all security checks; the server is untrusted
availability infrastructure.

## Notes

- SQLite is recommended only for local dev. In production, Prisma will use whatever database is specified by `DATABASE_URL`.
- The server automatically initializes Hyperlane registry and providers via `REGISTRY_URI`.
