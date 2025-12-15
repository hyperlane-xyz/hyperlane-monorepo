FROM node:20-slim AS builder

WORKDIR /hyperlane-monorepo

RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ make python3 python3-pip jq bash curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Foundry for solidity builds (soldeer)
RUN curl -L https://foundry.paradigm.xyz | bash
RUN /root/.foundry/bin/foundryup
ENV PATH="/root/.foundry/bin:${PATH}"

# Copy package.json first for corepack to read packageManager field
COPY package.json ./
RUN corepack enable && corepack install

# Copy pnpm config files
COPY pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy patches directory (required for pnpm install)
COPY patches ./patches

# Copy only the packages needed for ccip-server
COPY typescript/ccip-server/package.json ./typescript/ccip-server/
COPY typescript/deploy-sdk/package.json ./typescript/deploy-sdk/
COPY typescript/sdk/package.json ./typescript/sdk/
COPY typescript/provider-sdk/package.json ./typescript/provider-sdk/
COPY typescript/utils/package.json ./typescript/utils/
COPY typescript/cosmos-sdk/package.json ./typescript/cosmos-sdk/
COPY typescript/cosmos-types/package.json ./typescript/cosmos-types/
COPY typescript/radix-sdk/package.json ./typescript/radix-sdk/
COPY typescript/tsconfig/package.json ./typescript/tsconfig/
COPY typescript/eslint-config/package.json ./typescript/eslint-config/
COPY solidity/package.json ./solidity/
COPY solhint-plugin/package.json ./solhint-plugin/
COPY starknet/package.json ./starknet/

# Copy prisma schema before install (needed for postinstall prisma generate)
COPY typescript/ccip-server/prisma ./typescript/ccip-server/prisma

# Set dummy DATABASE_URL for prisma generate during install (actual URL provided at runtime)
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

RUN pnpm install --frozen-lockfile

# Run prisma generate after install (needed to generate Prisma client)
RUN pnpm --filter @hyperlane-xyz/ccip-server prisma generate

# Copy source files
COPY turbo.json ./
COPY typescript/ccip-server ./typescript/ccip-server
COPY typescript/deploy-sdk ./typescript/deploy-sdk
COPY typescript/sdk ./typescript/sdk
COPY typescript/provider-sdk ./typescript/provider-sdk
COPY typescript/utils ./typescript/utils
COPY typescript/cosmos-sdk ./typescript/cosmos-sdk
COPY typescript/cosmos-types ./typescript/cosmos-types
COPY typescript/radix-sdk ./typescript/radix-sdk
COPY typescript/tsconfig ./typescript/tsconfig
COPY typescript/eslint-config ./typescript/eslint-config
COPY solidity ./solidity
COPY solhint-plugin ./solhint-plugin
COPY starknet ./starknet

# Build the ccip-server
RUN pnpm turbo run build --filter=@hyperlane-xyz/ccip-server

# Create standalone deployment with resolved dependencies (no symlinks)
# --legacy flag required for pnpm v10+ without inject-workspace-packages
RUN pnpm --filter @hyperlane-xyz/ccip-server deploy --legacy --prod /app

# Copy generated Prisma client to dist (TypeScript doesn't copy non-TS files)
RUN cp -r /app/src/generated /app/dist/generated

# Copy the generated Prisma client (pnpm deploy may not include .prisma)
RUN cp -r /hyperlane-monorepo/typescript/ccip-server/node_modules/.prisma /app/node_modules/.prisma 2>/dev/null || \
    cp -r /hyperlane-monorepo/node_modules/.prisma /app/node_modules/.prisma 2>/dev/null || \
    echo "Warning: Could not find .prisma directory"

# Production stage - Debian slim for Prisma native binary compatibility
FROM node:20-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy the deployed standalone package
COPY --from=builder /app ./

# Copy prisma schema for migrations
COPY --from=builder /hyperlane-monorepo/typescript/ccip-server/prisma ./prisma

# Environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV SERVER_PORT=3000

# Expose ports
EXPOSE 3000
EXPOSE 9090

# Run the ccip-server
CMD ["node", "dist/server.js"]
