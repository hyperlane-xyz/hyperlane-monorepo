# CCIP-Server (OffchainLookup)

A lightweight Express server for CCIP Read/Write commitments, using Zod validation and Prisma for persistence.

## Prerequisites

- Node.js >=16
- Yarn or npm
- SQLite (for local development)
- A GCP (or other) SQL database URL for production

## Setup

1. **Install dependencies**

   ```bash
   cd typescript/ccip-server
   yarn install    # or `npm install`
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
  yarn dev     # runs `tsx watch src/server.ts`
  ```

- **Production**

  ```bash
  # Apply migrations without prompts
  NODE_ENV=production \
  DATABASE_URL="<YOUR_PROD_URL>" \
    npx prisma migrate deploy

  # Start the compiled server
  NODE_ENV=production yarn start
  ```

## API Routes

- `POST /calls`
  Submit a new commitment payload. Validated via Zod; persists to the database.

- `POST /getCallsFromCommitment`
  CCIP-Read endpoint (uses ABI handler) to fetch & re-encode calls for a given commitment ID.

## Notes

- SQLite is recommended only for local dev. In production, Prisma will use whatever database is specified by `DATABASE_URL`.
- The server automatically initializes Hyperlane registry and providers via `REGISTRY_URI`.
