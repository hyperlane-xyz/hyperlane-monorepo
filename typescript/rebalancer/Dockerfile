FROM node:20-alpine AS builder

WORKDIR /hyperlane-monorepo

# Install build dependencies
RUN apk add --update --no-cache git g++ make py3-pip jq bash curl \
    && yarn set version 4.5.1

# Install Foundry for solidity builds (soldeer) - use Alpine-compatible binaries
ARG TARGETARCH
COPY solidity/.foundryrc ./solidity/
RUN FOUNDRY_VERSION=$(cat solidity/.foundryrc) && \
    ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl -L "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_alpine_${ARCH}.tar.gz" \
    | tar -xzC /usr/local/bin

# Copy package.json and yarn config
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/plugins ./.yarn/plugins
COPY .yarn/releases ./.yarn/releases
COPY .yarn/patches ./.yarn/patches

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

RUN yarn install && yarn cache clean

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
RUN yarn turbo run bundle --filter=@hyperlane-xyz/rebalancer

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
