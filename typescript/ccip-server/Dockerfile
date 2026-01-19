FROM node:20-slim AS builder

WORKDIR /hyperlane-monorepo

RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ make python3 python3-pip jq bash curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Foundry (Linux binaries) - pinned version for reproducibility
ARG FOUNDRY_VERSION
ARG SERVICE_VERSION=dev
ARG TARGETARCH
SHELL ["/bin/bash", "-c"]
RUN set -o pipefail && \
    ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl --fail -L "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${ARCH}.tar.gz" | tar -xzC /usr/local/bin forge cast
SHELL ["/bin/sh", "-c"]

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
COPY typescript/aleo-sdk/package.json ./typescript/aleo-sdk/
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
COPY typescript/aleo-sdk ./typescript/aleo-sdk
COPY typescript/tsconfig ./typescript/tsconfig
COPY typescript/eslint-config ./typescript/eslint-config
COPY solidity ./solidity
COPY solhint-plugin ./solhint-plugin
COPY starknet ./starknet

# Pre-download solc compiler to avoid flaky network issues during build.
# Hardhat downloads this on-demand, but the network request can timeout in CI.
#
# To update when changing solidity version in solidity/rootHardhatConfig.cts:
#   1. Find the commit hash: curl -s "https://binaries.soliditylang.org/linux-amd64/list.json" | jq '.releases["X.Y.Z"]'
#   2. Update SOLC_VERSION and SOLC_COMMIT below
ARG SOLC_VERSION=0.8.22
ARG SOLC_COMMIT=4fc1097e
RUN SOLC_BINARY="solc-linux-amd64-v${SOLC_VERSION}+commit.${SOLC_COMMIT}" && \
    SOLC_LIST_URL="https://binaries.soliditylang.org/linux-amd64/list.json" && \
    SOLC_BIN_URL="https://binaries.soliditylang.org/linux-amd64/${SOLC_BINARY}" && \
    CACHE_DIR="/root/.cache/hardhat-nodejs/compilers-v2/linux-amd64" && \
    mkdir -p "$CACHE_DIR" && \
    curl --retry 5 --retry-delay 5 --retry-all-errors -fsSL "$SOLC_LIST_URL" -o "$CACHE_DIR/list.json" && \
    curl --retry 5 --retry-delay 5 --retry-all-errors -fsSL "$SOLC_BIN_URL" -o "$CACHE_DIR/${SOLC_BINARY}" && \
    chmod +x "$CACHE_DIR/${SOLC_BINARY}"

# Build the ccip-server
RUN pnpm turbo run build --filter=@hyperlane-xyz/ccip-server

# Create standalone deployment with resolved dependencies (no symlinks)
# --legacy flag required for pnpm v10+ without inject-workspace-packages
RUN pnpm --filter @hyperlane-xyz/ccip-server deploy --legacy --prod /app

# Copy generated Prisma client to dist (TypeScript doesn't copy non-TS files)
# Note: Prisma outputs to src/generated/prisma/ (custom path), not node_modules/.prisma
RUN cp -r /app/src/generated /app/dist/generated

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
ARG SERVICE_VERSION=dev
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV SERVER_PORT=3000
ENV SERVICE_VERSION=${SERVICE_VERSION}

# Expose ports
EXPOSE 3000
EXPOSE 9090

# Run the ccip-server
CMD ["node", "dist/server.js"]
