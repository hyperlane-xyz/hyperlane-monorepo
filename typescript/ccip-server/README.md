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

- `POST /calls`  
  Submit a new commitment payload. Validated via Zod; persists to the database.

  Config-based registration defaults to `interchainAccountRouter`. When using
  another deployment, supply `localRouter` (origin) and `routerOverride`
  (destination), for example the registry's `interchainAccountRouterV3` pair.
  Alternatively, supply `commitmentDispatchTx` using the legacy receipt-based
  registration shape. Compare the response's `ica` with the intended account.

- `POST /getCallsFromRevealMessage`
  CCIP-Read endpoint (uses ABI handler) to fetch & re-encode calls for a reveal message.

  Relayers may include `origin_tx_hash` in the authenticated request. The server
  verifies the exact reveal and its matching commitment dispatch in that
  transaction's mailbox events, then derives the ICA from the actual router pair.
  This also recovers records previously derived from the wrong router version;
  stored calldata and access restrictions remain unchanged. Without the hash,
  the server uses the stored ICA.

## Notes

- SQLite is recommended only for local dev. In production, Prisma will use whatever database is specified by `DATABASE_URL`.
- The server automatically initializes Hyperlane registry and providers via `REGISTRY_URI`.
