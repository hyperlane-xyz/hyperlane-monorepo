FROM node:20-slim AS builder

WORKDIR /hyperlane-monorepo

RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ make python3 python3-pip jq bash curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Foundry (Linux binaries) - pinned version for reproducibility
ARG FOUNDRY_VERSION
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

# Copy only the packages needed for relayer
COPY solhint-plugin/package.json ./solhint-plugin/
COPY solidity/package.json ./solidity/
COPY starknet/package.json ./starknet/
COPY typescript/aleo-sdk/package.json ./typescript/aleo-sdk/
COPY typescript/cosmos-sdk/package.json ./typescript/cosmos-sdk/
COPY typescript/cosmos-types/package.json ./typescript/cosmos-types/
COPY typescript/deploy-sdk/package.json ./typescript/deploy-sdk/
COPY typescript/eslint-config/package.json ./typescript/eslint-config/
COPY typescript/metrics/package.json ./typescript/metrics/
COPY typescript/provider-sdk/package.json ./typescript/provider-sdk/
COPY typescript/radix-sdk/package.json ./typescript/radix-sdk/
COPY typescript/relayer/package.json ./typescript/relayer/
COPY typescript/sdk/package.json ./typescript/sdk/
COPY typescript/tsconfig/package.json ./typescript/tsconfig/
COPY typescript/utils/package.json ./typescript/utils/

RUN pnpm install --frozen-lockfile

# Copy source files
COPY turbo.json ./
COPY solhint-plugin ./solhint-plugin
COPY solidity ./solidity
COPY starknet ./starknet
COPY typescript/aleo-sdk ./typescript/aleo-sdk
COPY typescript/cosmos-sdk ./typescript/cosmos-sdk
COPY typescript/cosmos-types ./typescript/cosmos-types
COPY typescript/deploy-sdk ./typescript/deploy-sdk
COPY typescript/eslint-config ./typescript/eslint-config
COPY typescript/metrics ./typescript/metrics
COPY typescript/provider-sdk ./typescript/provider-sdk
COPY typescript/radix-sdk ./typescript/radix-sdk
COPY typescript/relayer ./typescript/relayer
COPY typescript/sdk ./typescript/sdk
COPY typescript/tsconfig ./typescript/tsconfig
COPY typescript/utils ./typescript/utils

# Build and bundle the relayer (ncc creates a single-file bundle with all deps)
RUN pnpm turbo run bundle --filter=@hyperlane-xyz/relayer

# Production stage - minimal Alpine image with just the bundled code
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache ca-certificates

# Copy only the bundled output (includes all dependencies)
COPY --from=builder /hyperlane-monorepo/typescript/relayer/relayer-bundle ./relayer-bundle
COPY --from=builder /hyperlane-monorepo/typescript/relayer/package.json ./

# Environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Expose metrics port
EXPOSE 9090

# Run the relayer service from the bundle
CMD ["node", "relayer-bundle/index.js"]
