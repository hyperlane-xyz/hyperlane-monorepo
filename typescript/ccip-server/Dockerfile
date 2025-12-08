FROM node:20-slim AS builder

WORKDIR /hyperlane-monorepo

RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ make python3 python3-pip jq bash curl ca-certificates unzip openssl \
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

# Copy only the packages needed for ccip-server
COPY typescript/ccip-server/package.json ./typescript/ccip-server/
COPY typescript/sdk/package.json ./typescript/sdk/
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
COPY typescript/ccip-server ./typescript/ccip-server
COPY typescript/sdk ./typescript/sdk
COPY typescript/utils ./typescript/utils
COPY typescript/cosmos-sdk ./typescript/cosmos-sdk
COPY typescript/cosmos-types ./typescript/cosmos-types
COPY typescript/radix-sdk ./typescript/radix-sdk
COPY typescript/tsconfig ./typescript/tsconfig
COPY typescript/eslint-config ./typescript/eslint-config
COPY solidity ./solidity
COPY solhint-plugin ./solhint-plugin
COPY starknet ./starknet

# Build the ccip-server (generates prisma client and compiles TypeScript)
RUN yarn turbo run build --filter=@hyperlane-xyz/ccip-server

# Production stage - minimal image with built code
FROM node:20-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

# Copy the built application
COPY --from=builder /hyperlane-monorepo/typescript/ccip-server/dist ./dist
COPY --from=builder /hyperlane-monorepo/typescript/ccip-server/src/generated ./src/generated
COPY --from=builder /hyperlane-monorepo/typescript/ccip-server/prisma ./prisma
COPY --from=builder /hyperlane-monorepo/typescript/ccip-server/package.json ./
COPY --from=builder /hyperlane-monorepo/typescript/ccip-server/node_modules ./node_modules

# Environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV SERVER_PORT=3000

# Expose ports
EXPOSE 3000
EXPOSE 9090

# Run the ccip-server
CMD ["node", "dist/server.js"]
