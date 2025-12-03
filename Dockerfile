# Stage 1: Extract package.json files while preserving directory structure
# This eliminates the need to manually add COPY statements for new packages
FROM node:20-alpine AS package-json-extractor

WORKDIR /source
COPY . .

# Create directory structure and copy all package.json files
RUN mkdir -p /package-jsons && \
    # Copy root files
    cp package.json yarn.lock .yarnrc.yml /package-jsons/ && \
    cp -r .yarn /package-jsons/.yarn && \
    # Find and copy all package.json files, preserving directory structure
    find typescript solidity solhint-plugin starknet -name "package.json" -type f | while read f; do \
        mkdir -p "/package-jsons/$(dirname $f)" && \
        cp "$f" "/package-jsons/$f"; \
    done && \
    # Copy special directories needed for install (e.g., prisma schema)
    mkdir -p /package-jsons/typescript/ccip-server && \
    cp -r typescript/ccip-server/prisma /package-jsons/typescript/ccip-server/ 2>/dev/null || true

# Stage 2: Main build
FROM node:20-alpine

WORKDIR /hyperlane-monorepo

RUN apk add --update --no-cache git g++ make py3-pip jq bash curl && \
    yarn set version 4.5.1

# Copy package.json files from extractor stage
COPY --from=package-json-extractor /package-jsons/. .

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
