# syntax=docker/dockerfile:1.4
# Dockerfile for multi-stage build of Hyperlane's Rust components
# https://docs.docker.com/build/building/multi-stage/#use-multi-stage-builds
# https://depot.dev/docs/container-builds/how-to-guides/optimal-dockerfiles/rust-dockerfile

# -------- Base Image with Tools --------
# Base image containing all necessary build tools and dependencies
FROM rust:1.88.0 AS base
RUN apt-get update && \
    apt-get install -y --no-install-recommends musl-tools clang && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    rustup target add x86_64-unknown-linux-musl && \
    cargo install --locked sccache

# Configure sccache for faster builds
# https://github.com/mozilla/sccache
ENV RUSTC_WRAPPER=sccache
ENV SCCACHE_DIR=/sccache

# -------- Dependencies Stage --------
# Build dependencies separately for better caching
# This layer only changes when Cargo.toml/Cargo.lock change
FROM base AS deps

WORKDIR /usr/src/rust/main

# Copy only dependency specification files first
COPY rust/main/Cargo.toml rust/main/Cargo.lock ./

# Copy all Cargo.toml files to establish workspace structure
# We need the full directory structure but only Cargo.toml files
COPY rust/main/agents/relayer/Cargo.toml ./agents/relayer/
COPY rust/main/agents/scraper/Cargo.toml ./agents/scraper/
COPY rust/main/agents/validator/Cargo.toml ./agents/validator/
COPY rust/main/applications/hyperlane-application/Cargo.toml ./applications/hyperlane-application/
COPY rust/main/applications/hyperlane-operation-verifier/Cargo.toml ./applications/hyperlane-operation-verifier/
COPY rust/main/applications/hyperlane-warp-route/Cargo.toml ./applications/hyperlane-warp-route/
COPY rust/main/chains/hyperlane-aleo/Cargo.toml ./chains/hyperlane-aleo/
COPY rust/main/chains/hyperlane-cosmos/Cargo.toml ./chains/hyperlane-cosmos/
COPY rust/main/chains/hyperlane-ethereum/Cargo.toml ./chains/hyperlane-ethereum/
COPY rust/main/chains/hyperlane-fuel/Cargo.toml ./chains/hyperlane-fuel/
COPY rust/main/chains/hyperlane-radix/Cargo.toml ./chains/hyperlane-radix/
COPY rust/main/chains/hyperlane-sealevel/Cargo.toml ./chains/hyperlane-sealevel/
COPY rust/main/chains/hyperlane-starknet/Cargo.toml ./chains/hyperlane-starknet/
COPY rust/main/ethers-prometheus/Cargo.toml ./ethers-prometheus/
COPY rust/main/hyperlane-base/Cargo.toml ./hyperlane-base/
COPY rust/main/hyperlane-core/Cargo.toml ./hyperlane-core/
COPY rust/main/hyperlane-metric/Cargo.toml ./hyperlane-metric/
COPY rust/main/hyperlane-test/Cargo.toml ./hyperlane-test/
COPY rust/main/lander/Cargo.toml ./lander/
COPY rust/main/utils/abigen/Cargo.toml ./utils/abigen/
COPY rust/main/utils/aleo-serialize/Cargo.toml ./utils/aleo-serialize/
COPY rust/main/utils/aleo-serialize-macro/Cargo.toml ./utils/aleo-serialize-macro/
COPY rust/main/utils/backtrace-oneline/Cargo.toml ./utils/backtrace-oneline/
COPY rust/main/utils/crypto/Cargo.toml ./utils/crypto/
COPY rust/main/utils/hex/Cargo.toml ./utils/hex/
COPY rust/main/utils/reqwest-utils/Cargo.toml ./utils/reqwest-utils/
COPY rust/main/utils/run-locally/Cargo.toml ./utils/run-locally/

# Copy sealevel workspace Cargo files (path dependencies from main workspace)
COPY rust/sealevel/Cargo.toml rust/sealevel/Cargo.lock ../sealevel/
COPY rust/sealevel/libraries/account-utils/Cargo.toml ../sealevel/libraries/account-utils/
COPY rust/sealevel/libraries/access-control/Cargo.toml ../sealevel/libraries/access-control/
COPY rust/sealevel/libraries/ecdsa-signature/Cargo.toml ../sealevel/libraries/ecdsa-signature/
COPY rust/sealevel/libraries/interchain-security-module-interface/Cargo.toml ../sealevel/libraries/interchain-security-module-interface/
COPY rust/sealevel/libraries/message-recipient-interface/Cargo.toml ../sealevel/libraries/message-recipient-interface/
COPY rust/sealevel/libraries/multisig-ism/Cargo.toml ../sealevel/libraries/multisig-ism/
COPY rust/sealevel/libraries/serializable-account-meta/Cargo.toml ../sealevel/libraries/serializable-account-meta/
COPY rust/sealevel/libraries/test-transaction-utils/Cargo.toml ../sealevel/libraries/test-transaction-utils/
COPY rust/sealevel/libraries/test-utils/Cargo.toml ../sealevel/libraries/test-utils/
COPY rust/sealevel/programs/hyperlane-sealevel-igp/Cargo.toml ../sealevel/programs/hyperlane-sealevel-igp/
COPY rust/sealevel/programs/hyperlane-sealevel-igp-test/Cargo.toml ../sealevel/programs/hyperlane-sealevel-igp-test/
COPY rust/sealevel/programs/hyperlane-sealevel-token/Cargo.toml ../sealevel/programs/hyperlane-sealevel-token/
COPY rust/sealevel/programs/hyperlane-sealevel-token-collateral/Cargo.toml ../sealevel/programs/hyperlane-sealevel-token-collateral/
COPY rust/sealevel/programs/hyperlane-sealevel-token-native/Cargo.toml ../sealevel/programs/hyperlane-sealevel-token-native/
COPY rust/sealevel/programs/ism/multisig-ism-message-id/Cargo.toml ../sealevel/programs/ism/multisig-ism-message-id/
COPY rust/sealevel/programs/mailbox/Cargo.toml ../sealevel/programs/mailbox/
COPY rust/sealevel/programs/mailbox-test/Cargo.toml ../sealevel/programs/mailbox-test/
COPY rust/sealevel/programs/test-send-receiver/Cargo.toml ../sealevel/programs/test-send-receiver/
COPY rust/sealevel/programs/validator-announce/Cargo.toml ../sealevel/programs/validator-announce/

# Create dummy source files to satisfy cargo
RUN find . -name "Cargo.toml" -exec sh -c 'mkdir -p $(dirname {})/src && echo "fn main() {}" > $(dirname {})/src/main.rs && touch $(dirname {})/src/lib.rs' \; && \
    find ../sealevel -name "Cargo.toml" -exec sh -c 'mkdir -p $(dirname {})/src && echo "fn main() {}" > $(dirname {})/src/main.rs && touch $(dirname {})/src/lib.rs' \;

# Build dependencies only (this layer is cached)
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=$SCCACHE_DIR,sharing=locked \
    RUSTFLAGS="--cfg tokio_unstable" \
    cargo build --release --bin validator --bin relayer --bin scraper 2>/dev/null || true

# -------- Builder Stage --------
# This stage compiles the actual source
FROM base AS builder

WORKDIR /usr/src/rust/main

# Copy cached dependencies from deps stage
COPY --from=deps /usr/local/cargo /usr/local/cargo
COPY --from=deps /usr/src/rust/main/target ./target

# Copy git metadata for version information
COPY .git ../../.git

# Copy all source code
COPY rust/main ./
COPY rust/sealevel ../sealevel

# Build the release binaries with caching enabled
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=$SCCACHE_DIR,sharing=locked \
    RUSTFLAGS="--cfg tokio_unstable" \
    cargo build --release --bin validator --bin relayer --bin scraper && \
    mkdir -p /release && \
    cp target/release/validator /release && \
    cp target/release/relayer /release && \
    cp target/release/scraper /release

# -------- Runtime Image --------
# Minimal runtime image containing config, binaries, and runtime dependencies
FROM ubuntu:22.04
WORKDIR /app
COPY rust/main/config /app/config
COPY rust/main/app-contexts /app/app-contexts
COPY --from=builder /release/* .

# Install runtime dependencies
# remove /var/lib/apt/lists/* to clean up the package lists
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates tini libcurl4 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    chmod 777 /app && \
    mkdir -p /usr/share/hyperlane && chmod 1000 /usr/share/hyperlane && \
    mkdir -p /data && chown -R 1000 /data

# Run as non-root user for security
# Use tini as init system for proper process management
USER 1000
ENTRYPOINT ["tini", "--"]
CMD ["./validator"]
