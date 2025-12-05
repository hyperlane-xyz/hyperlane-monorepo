FROM node:20-slim AS builder

WORKDIR /hyperlane-monorepo

RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ make python3 python3-pip jq bash curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/* \
    && yarn set version 4.5.1

# Install Foundry for solidity builds (soldeer)
RUN curl -L https://foundry.paradigm.xyz | bash
RUN /root/.foundry/bin/foundryup
ENV PATH="/root/.foundry/bin:${PATH}"

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

# Build only the rebalancer and its dependencies
RUN yarn turbo run build --filter=@hyperlane-xyz/rebalancer...

# Production stage
FROM node:20-slim AS runner

WORKDIR /hyperlane-monorepo

RUN apt-get update && apt-get install -y --no-install-recommends \
    git jq bash curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy built artifacts and node_modules
COPY --from=builder /hyperlane-monorepo/package.json ./
COPY --from=builder /hyperlane-monorepo/yarn.lock ./
COPY --from=builder /hyperlane-monorepo/.yarnrc.yml ./
COPY --from=builder /hyperlane-monorepo/.yarn ./.yarn
COPY --from=builder /hyperlane-monorepo/node_modules ./node_modules
COPY --from=builder /hyperlane-monorepo/typescript/rebalancer ./typescript/rebalancer
COPY --from=builder /hyperlane-monorepo/typescript/deploy-sdk ./typescript/deploy-sdk
COPY --from=builder /hyperlane-monorepo/typescript/sdk ./typescript/sdk
COPY --from=builder /hyperlane-monorepo/typescript/provider-sdk ./typescript/provider-sdk
COPY --from=builder /hyperlane-monorepo/typescript/utils ./typescript/utils
COPY --from=builder /hyperlane-monorepo/typescript/cosmos-sdk ./typescript/cosmos-sdk
COPY --from=builder /hyperlane-monorepo/typescript/cosmos-types ./typescript/cosmos-types
COPY --from=builder /hyperlane-monorepo/typescript/radix-sdk ./typescript/radix-sdk
COPY --from=builder /hyperlane-monorepo/typescript/tsconfig ./typescript/tsconfig

# Baked-in registry version
ENV REGISTRY_URI="/hyperlane-registry"
ARG REGISTRY_COMMIT="main"
RUN git clone https://github.com/hyperlane-xyz/hyperlane-registry.git "$REGISTRY_URI" \
    && cd "$REGISTRY_URI" \
    && git fetch origin "$REGISTRY_COMMIT" \
    && git checkout "$REGISTRY_COMMIT"

# Environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Expose metrics port
EXPOSE 9090

# Run the rebalancer service
CMD ["node", "typescript/rebalancer/dist/service.js"]
