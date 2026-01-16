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

# Copy only the packages needed for rebalancer
COPY typescript/rebalancer/package.json ./typescript/rebalancer/
COPY typescript/warp-metrics/package.json ./typescript/warp-metrics/
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

RUN pnpm install --frozen-lockfile

# Copy source files
COPY turbo.json ./
COPY typescript/rebalancer ./typescript/rebalancer
COPY typescript/warp-metrics ./typescript/warp-metrics
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

# Build and bundle the rebalancer (ncc creates a single-file bundle with all deps)
RUN pnpm turbo run bundle --filter=@hyperlane-xyz/rebalancer

# Production stage - minimal Alpine image with just the bundled code
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache ca-certificates

# Copy only the bundled output (includes all dependencies)
COPY --from=builder /hyperlane-monorepo/typescript/rebalancer/bundle ./bundle

# Install external dependencies that ncc doesn't bundle (dynamic imports)
RUN npm install @google-cloud/pino-logging-gcp-config

# Environment variables
ARG SERVICE_VERSION=dev
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV SERVICE_VERSION=${SERVICE_VERSION}

# Expose metrics port
EXPOSE 9090

# Run the rebalancer service from the bundle
CMD ["node", "bundle/index.js"]
