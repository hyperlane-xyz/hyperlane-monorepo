FROM node:20-alpine

WORKDIR /hyperlane-monorepo

RUN apk add --update --no-cache git g++ make py3-pip jq bash curl

# Install Foundry (Alpine binaries) - pinned version for reproducibility
ARG FOUNDRY_VERSION
ARG TARGETARCH
RUN set -o pipefail && \
    ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl --fail -L "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_alpine_${ARCH}.tar.gz" | tar -xzC /usr/local/bin forge cast

# Copy package.json first for corepack to read packageManager field
COPY package.json ./
RUN corepack enable && corepack install

# Copy remaining config files
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches

COPY typescript/aleo-sdk/package.json ./typescript/aleo-sdk/
COPY typescript/ccip-server/package.json ./typescript/ccip-server/
COPY typescript/ccip-server/prisma ./typescript/ccip-server/prisma
COPY typescript/cli/package.json ./typescript/cli/
COPY typescript/cosmos-sdk/package.json ./typescript/cosmos-sdk/
COPY typescript/cosmos-types/package.json ./typescript/cosmos-types/
COPY typescript/deploy-sdk/package.json ./typescript/deploy-sdk/
COPY typescript/eslint-config/package.json ./typescript/eslint-config/
COPY typescript/github-proxy/package.json ./typescript/github-proxy/
COPY typescript/helloworld/package.json ./typescript/helloworld/
COPY typescript/http-registry-server/package.json ./typescript/http-registry-server/
COPY typescript/infra/package.json ./typescript/infra/
COPY typescript/provider-sdk/package.json ./typescript/provider-sdk/
COPY typescript/radix-sdk/package.json ./typescript/radix-sdk/
COPY typescript/rebalancer/package.json ./typescript/rebalancer/
COPY typescript/sdk/package.json ./typescript/sdk/
COPY typescript/tsconfig/package.json ./typescript/tsconfig/
COPY typescript/utils/package.json ./typescript/utils/
COPY typescript/warp-monitor/package.json ./typescript/warp-monitor/
COPY typescript/widgets/package.json ./typescript/widgets/
COPY solidity/package.json ./solidity/
COPY solhint-plugin/package.json ./solhint-plugin/
COPY starknet/package.json ./starknet/

# Set dummy DATABASE_URL for ccip-server prisma generate during install
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

RUN pnpm install --frozen-lockfile && pnpm store prune

# Copy everything else
COPY turbo.json ./
COPY typescript ./typescript
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

RUN pnpm build

# Baked-in registry version
# keep for back-compat until we update all usage of the monorepo image (e.g. key-funder)
ENV REGISTRY_URI="/hyperlane-registry"
ARG REGISTRY_COMMIT="main"
RUN git clone https://github.com/hyperlane-xyz/hyperlane-registry.git "$REGISTRY_URI" \
    && cd "$REGISTRY_URI" \
    && git fetch origin "$REGISTRY_COMMIT" \
    && git checkout "$REGISTRY_COMMIT"

# Add entrypoint script that allows overriding the registry commit
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
