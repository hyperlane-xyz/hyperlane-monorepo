FROM node:20-slim

WORKDIR /hyperlane-monorepo

RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ make python3 python3-pip jq bash curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/* \
    && yarn set version 4.5.1

# Install Foundry for solidity builds (early for layer caching)
RUN curl -L https://foundry.paradigm.xyz | bash
RUN /root/.foundry/bin/foundryup
ENV PATH="/root/.foundry/bin:${PATH}"

# Copy package.json and friends
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/plugins ./.yarn/plugins
COPY .yarn/releases ./.yarn/releases
COPY .yarn/patches ./.yarn/patches

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
COPY typescript/sdk/package.json ./typescript/sdk/
COPY typescript/tsconfig/package.json ./typescript/tsconfig/
COPY typescript/utils/package.json ./typescript/utils/
COPY typescript/widgets/package.json ./typescript/widgets/
COPY solidity/package.json ./solidity/
COPY solhint-plugin/package.json ./solhint-plugin/
COPY starknet/package.json ./starknet/

RUN yarn install && yarn cache clean

# Copy everything else
COPY turbo.json ./
COPY typescript ./typescript
COPY solidity ./solidity
COPY solhint-plugin ./solhint-plugin
COPY starknet ./starknet

RUN yarn build

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
