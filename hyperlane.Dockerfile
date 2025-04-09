# A dockerfile combining all needed tools to set up hyperlane relayer, validators
# and evm counterparty for testing hyperlane module in sov sdk

FROM rust:1.85

ENV CARGO_NET_GIT_FETCH_WITH_CLI=true

RUN apt-get update && \
  apt-get install -y --no-install-recommends libclang-dev jq vim && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

# ANVIL

RUN curl -L https://foundry.paradigm.xyz | bash
RUN ~/.foundry/bin/foundryup
RUN <<EOF cat > /usr/bin/anvil
#!/bin/bash
~/.foundry/bin/anvil | tee /anvil.log
EOF
RUN chmod +x /usr/bin/anvil

# HYPERLANE CLI

WORKDIR /hyperlane-monorepo

# copy only needed stuff to not cause rebuilds by changing rust sources
COPY *.json *.yaml *.yml .*.yml *.mjs .*rc *.lock ./
COPY .yarn ./.yarn
COPY typescript ./typescript
COPY solidity ./solidity

ENV NVM_DIR=/usr/local/nvm
ENV NVM_VERSION=0.39.7
ENV NODE_VERSION=20

RUN mkdir -p "$NVM_DIR" && \
  curl "https://raw.githubusercontent.com/creationix/nvm/v$NVM_VERSION/install.sh" | bash && \
  . "$NVM_DIR/nvm.sh" && \
  nvm install "$NODE_VERSION" && \
  nvm alias default "$NODE_VERSION" && \
  nvm use default && \
  npm install -g yarn && \
  cd typescript && \
  yarn install && \
  yarn build

RUN <<EOF cat > /usr/bin/hyperlane
#!/bin/bash
yarn --cwd /hyperlane-monorepo/typescript/cli hyperlane "\$@"
EOF
RUN chmod +x /usr/bin/hyperlane

# RELAYER + VALIDATOR

COPY rust ./rust

# the dependency on sovereign sdk is git based, so we need to pass the
# authorized ssh key into the container
RUN mkdir -p /root/.ssh && ssh-keyscan github.com >> /root/.ssh/known_hosts
RUN --mount=type=ssh \
    --mount=type=cache,target=/hyperlane-monorepo/rust/main/target \
    --mount=type=cache,target=/usr/local/cargo/git/db \
    --mount=type=cache,target=/usr/local/cargo/registry/ \
  cd rust/main && \
  touch chains/hyperlane-fuel/abis/* && \
  cargo build --features sov-sdk-testing --release --bin relayer --bin validator && \
  cp target/release/relayer target/release/validator /usr/bin
