FROM node:20-alpine

WORKDIR /hyperlane-monorepo

RUN apk add --update --no-cache git g++ make py3-pip jq

RUN yarn set version 4.5.1

# Copy package.json and friends
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/plugins ./.yarn/plugins
COPY .yarn/releases ./.yarn/releases
COPY .yarn/patches ./.yarn/patches
COPY typescript/utils/package.json ./typescript/utils/
COPY typescript/sdk/package.json ./typescript/sdk/
COPY typescript/helloworld/package.json ./typescript/helloworld/
COPY typescript/cli/package.json ./typescript/cli/
COPY typescript/infra/package.json ./typescript/infra/
COPY typescript/ccip-server/package.json ./typescript/ccip-server/
COPY typescript/widgets/package.json ./typescript/widgets/
COPY typescript/github-proxy/package.json ./typescript/github-proxy/
COPY typescript/cosmos-types/package.json ./typescript/cosmos-types/
COPY typescript/cosmos-sdk/package.json ./typescript/cosmos-sdk/
COPY solidity/package.json ./solidity/
COPY starknet/package.json ./starknet/

RUN yarn install && yarn cache clean

# Copy everything else
COPY tsconfig.json ./
COPY typescript ./typescript
COPY solidity ./solidity
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
