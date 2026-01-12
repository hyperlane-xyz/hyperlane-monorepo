FROM node:20-slim AS builder

WORKDIR /hyperlane-monorepo

RUN apt-get update && apt-get install -y --no-install-recommends \
    git g++ make python3 python3-pip jq bash curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

ARG FOUNDRY_VERSION
ARG SERVICE_VERSION=dev
ARG TARGETARCH
SHELL ["/bin/bash", "-c"]
RUN set -o pipefail && \
    ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") && \
    curl --fail -L "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${ARCH}.tar.gz" | tar -xzC /usr/local/bin forge cast
SHELL ["/bin/sh", "-c"]

COPY package.json ./
RUN corepack enable && corepack install

COPY pnpm-lock.yaml pnpm-workspace.yaml ./

COPY patches ./patches

COPY typescript/aleo-sdk/package.json ./typescript/aleo-sdk/
COPY typescript/keyfunder/package.json ./typescript/keyfunder/
COPY typescript/sdk/package.json ./typescript/sdk/
COPY typescript/provider-sdk/package.json ./typescript/provider-sdk/
COPY typescript/utils/package.json ./typescript/utils/
COPY typescript/cosmos-sdk/package.json ./typescript/cosmos-sdk/
COPY typescript/cosmos-types/package.json ./typescript/cosmos-types/
COPY typescript/radix-sdk/package.json ./typescript/radix-sdk/
COPY typescript/tsconfig/package.json ./typescript/tsconfig/
COPY typescript/eslint-config/package.json ./typescript/eslint-config/
COPY typescript/deploy-sdk/package.json ./typescript/deploy-sdk/
COPY solidity/package.json ./solidity/
COPY solhint-plugin/package.json ./solhint-plugin/
COPY starknet/package.json ./starknet/

RUN pnpm install --frozen-lockfile

COPY turbo.json ./
COPY typescript/aleo-sdk ./typescript/aleo-sdk
COPY typescript/keyfunder ./typescript/keyfunder
COPY typescript/sdk ./typescript/sdk
COPY typescript/provider-sdk ./typescript/provider-sdk
COPY typescript/utils ./typescript/utils
COPY typescript/cosmos-sdk ./typescript/cosmos-sdk
COPY typescript/cosmos-types ./typescript/cosmos-types
COPY typescript/radix-sdk ./typescript/radix-sdk
COPY typescript/tsconfig ./typescript/tsconfig
COPY typescript/eslint-config ./typescript/eslint-config
COPY typescript/deploy-sdk ./typescript/deploy-sdk
COPY solidity ./solidity
COPY solhint-plugin ./solhint-plugin
COPY starknet ./starknet

RUN pnpm turbo run bundle --filter=@hyperlane-xyz/keyfunder

FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY --from=builder /hyperlane-monorepo/typescript/keyfunder/bundle ./bundle

RUN npm install @google-cloud/pino-logging-gcp-config

ARG SERVICE_VERSION=dev
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV SERVICE_VERSION=${SERVICE_VERSION}

CMD ["node", "bundle/index.js"]
