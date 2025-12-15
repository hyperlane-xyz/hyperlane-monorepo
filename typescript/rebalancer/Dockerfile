FROM node:20-slim AS builder

WORKDIR /hyperlane-monorepo

RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ make python3 python3-pip jq bash curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Foundry for solidity builds (soldeer)
RUN curl -L https://foundry.paradigm.xyz | bash
RUN /root/.foundry/bin/foundryup
ENV PATH="/root/.foundry/bin:${PATH}"

# Copy package.json first to extract pnpm version
COPY package.json ./

# Install pnpm version from packageManager field in package.json
RUN PNPM_VERSION=$(jq -r '.packageManager' package.json | sed 's/pnpm@//') && \
    npm install -g pnpm@$PNPM_VERSION

# Copy pnpm config files
COPY pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy only the packages needed for rebalancer
COPY typescript/rebalancer/package.json ./typescript/rebalancer/
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

RUN pnpm install --frozen-lockfile

# Copy source files
COPY turbo.json ./
COPY typescript/rebalancer ./typescript/rebalancer
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

# Build and bundle the rebalancer (ncc creates a single-file bundle with all deps)
RUN pnpm turbo run bundle --filter=@hyperlane-xyz/rebalancer

# Production stage - minimal Alpine image with just the bundled code
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache ca-certificates

# Copy only the bundled output (includes all dependencies)
COPY --from=builder /hyperlane-monorepo/typescript/rebalancer/rebalancer-bundle ./rebalancer-bundle
COPY --from=builder /hyperlane-monorepo/typescript/rebalancer/package.json ./

# Environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Expose metrics port
EXPOSE 9090

# Run the rebalancer service from the bundle
CMD ["node", "rebalancer-bundle/index.js"]
