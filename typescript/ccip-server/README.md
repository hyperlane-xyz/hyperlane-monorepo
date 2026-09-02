## OffchainLookup server

# CCIP-Server (OffchainLookup)

A lightweight Express server for CCIP Read/Write commitments, using Zod validation and Prisma for persistence.

## Prerequisites

- Node.js >=16
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

- `POST /calls`  
  Submit a new commitment payload. Validated via Zod; persists to the database.

- `POST /getCallsFromCommitment`  
  CCIP-Read endpoint (uses ABI handler) to fetch & re-encode calls for a given commitment ID.

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
receipt, validates every pathway and payload field, resolves current/grace
receive libraries from Endpoint state, and simulates `commitVerification`
before returning `(receiveLibrary, packet)`.
The destination contract repeats all security checks; the server is untrusted
availability infrastructure.

## Notes

- SQLite is recommended only for local dev. In production, Prisma will use whatever database is specified by `DATABASE_URL`.
- The server automatically initializes Hyperlane registry and providers via `REGISTRY_URI`.
