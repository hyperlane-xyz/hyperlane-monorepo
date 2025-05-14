# A dockerfile combining all needed tools to set up hyperlane relayer, validators
# and evm counterparty for testing hyperlane module in sov sdk

FROM rust:1.85 AS rust-builder

WORKDIR /hyperlane-monorepo

ENV CARGO_NET_GIT_FETCH_WITH_CLI=true

RUN apt-get update && \
  apt-get install -y --no-install-recommends libclang-dev jq && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/*

RUN curl -L https://foundry.paradigm.xyz | bash
RUN ~/.foundry/bin/foundryup

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
  cargo build --release --bin relayer --bin validator && \
  # still need to copy out of target bcs it's a cache mount so will be unmounted
  cp target/release/relayer target/release/validator /usr/bin


FROM debian:bookworm-slim AS runner

WORKDIR /build

# build and install @hyperlane-xyz/cli
# TODO: this clones branch that is much more up to date with
# upstream hyperlane-monorepo than the branch with rust components.
# This should be replaced with `COPY` as rust gets up to date with upstream.
RUN apt-get update && \
  apt-get install -y --no-install-recommends git libclang-dev npm jq make build-essential && \
  npm install -g yarn && \
  git clone https://github.com/eigerco/hyperlane-monorepo --depth 1 --branch sovereign-cli-support && \
  cd hyperlane-monorepo && \
  yarn install && \
  yarn build && \
  yarn workspace @hyperlane-xyz/cli bundle && \
  npm install -g ./typescript/cli && \
  apt-get remove --purge -y git jq make build-essential && \
  apt-get autoremove -y && \
  apt-get clean && \
  rm -rf /var/lib/apt/lists/* && \
  npm uninstall -g yarn && \
  npm cache clear --force && \
  cd - && \
  rm -rf hyperlane-monorepo

WORKDIR /app

# anvil
COPY --from=rust-builder /root/.foundry/bin/* /usr/bin
# rust and validators
COPY --from=rust-builder /usr/bin/relayer /usr/bin/validator /usr/bin
# hyperlane config files looked up by relative path
COPY --from=rust-builder /hyperlane-monorepo/rust/main/config ./config
