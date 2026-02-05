# Dockerfile for Ponder-based Hyperlane indexer
#
# Unlike NCC-bundled services, Ponder requires the full node_modules tree
# at runtime for its internal module resolution and hot-reloading capabilities.
#
# Build: docker build -t hyperlane-indexer -f typescript/indexer/Dockerfile .
# Run:   docker run -e DATABASE_URL=... -e DEPLOY_ENV=testnet4 hyperlane-indexer

FROM node:24-slim AS builder

WORKDIR /hyperlane-monorepo

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ make python3 ca-certificates curl bash jq unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Foundry (needed for solidity deps:soldeer)
ARG FOUNDRY_VERSION=v1.5.0
ARG TARGETARCH
SHELL ["/bin/bash", "-c"]
RUN set -o pipefail && \
    ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl --fail -L "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${ARCH}.tar.gz" | tar -xzC /usr/local/bin forge cast
SHELL ["/bin/sh", "-c"]

# Copy package.json first for corepack
COPY package.json ./
RUN corepack enable && corepack install

# Copy pnpm config files
COPY pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy patches directory (required for pnpm install)
COPY patches ./patches

# Copy package.json files for indexer and its workspace dependencies
COPY typescript/indexer/package.json ./typescript/indexer/
COPY typescript/sdk/package.json ./typescript/sdk/
COPY typescript/deploy-sdk/package.json ./typescript/deploy-sdk/
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

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source files for indexer and dependencies
COPY turbo.json ./
COPY typescript/indexer ./typescript/indexer
COPY typescript/sdk ./typescript/sdk
COPY typescript/deploy-sdk ./typescript/deploy-sdk
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

# Build the indexer and its dependencies
RUN pnpm turbo run build --filter=@hyperlane-xyz/indexer

# Production stage
FROM node:24-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json for corepack
COPY --from=builder /hyperlane-monorepo/package.json ./
RUN corepack enable && corepack install

# Copy pnpm workspace config
COPY --from=builder /hyperlane-monorepo/pnpm-lock.yaml ./
COPY --from=builder /hyperlane-monorepo/pnpm-workspace.yaml ./
COPY --from=builder /hyperlane-monorepo/patches ./patches

# Copy built packages and node_modules
# Ponder needs the full workspace structure for module resolution
COPY --from=builder /hyperlane-monorepo/node_modules ./node_modules
COPY --from=builder /hyperlane-monorepo/typescript/indexer ./typescript/indexer
COPY --from=builder /hyperlane-monorepo/typescript/sdk ./typescript/sdk
COPY --from=builder /hyperlane-monorepo/typescript/deploy-sdk ./typescript/deploy-sdk
COPY --from=builder /hyperlane-monorepo/typescript/provider-sdk ./typescript/provider-sdk
COPY --from=builder /hyperlane-monorepo/typescript/utils ./typescript/utils
COPY --from=builder /hyperlane-monorepo/typescript/cosmos-sdk ./typescript/cosmos-sdk
COPY --from=builder /hyperlane-monorepo/typescript/cosmos-types ./typescript/cosmos-types
COPY --from=builder /hyperlane-monorepo/typescript/radix-sdk ./typescript/radix-sdk
COPY --from=builder /hyperlane-monorepo/typescript/aleo-sdk ./typescript/aleo-sdk
COPY --from=builder /hyperlane-monorepo/typescript/tsconfig ./typescript/tsconfig

# Solidity ABIs needed by SDK
COPY --from=builder /hyperlane-monorepo/solidity ./solidity

WORKDIR /app/typescript/indexer

# Environment
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Ponder serves health/metrics on port 42069
EXPOSE 42069

# Run the indexer
CMD ["pnpm", "start"]
