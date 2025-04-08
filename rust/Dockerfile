# syntax=docker/dockerfile:1.4

# -------- Base Image with Tools --------
FROM rust:1.80.1 AS base
RUN apt-get update && \
    apt-get install -y musl-tools clang && \
    rustup target add x86_64-unknown-linux-musl && \
    cargo install --locked sccache

ENV RUSTC_WRAPPER=sccache
ENV SCCACHE_DIR=/sccache

# -------- Builder Stage --------
FROM base AS builder

# Workspace root
WORKDIR /usr/src/rust/main

# Required for vergen/git metadata
COPY .git ../../.git

# Copy all main crates and workspace files into correct subpaths
COPY rust/main/agents ./agents
COPY rust/main/applications ./applications
COPY rust/main/chains ./chains
COPY rust/main/ethers-prometheus ./ethers-prometheus
COPY rust/main/hyperlane-base ./hyperlane-base
COPY rust/main/hyperlane-core ./hyperlane-core
COPY rust/main/hyperlane-metric ./hyperlane-metric
COPY rust/main/hyperlane-test ./hyperlane-test
COPY rust/main/submitter ./submitter
COPY rust/main/utils ./utils
COPY rust/main/Cargo.toml ./
COPY rust/main/Cargo.lock ./

# Copy sealevel workspace into correct relative location
COPY rust/sealevel ../sealevel

# Build binaries and stage them
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
FROM ubuntu:22.04
WORKDIR /app
COPY rust/main/config /app/config
COPY --from=builder /release/* .

RUN apt-get update && \
    apt-get install -y openssl ca-certificates tini && \
    rm -rf /var/lib/apt/lists/* && \
    chmod 777 /app && \
    mkdir -p /usr/share/hyperlane && chmod 1000 /usr/share/hyperlane && \
    mkdir -p /data && chown -R 1000 /data

USER 1000
ENTRYPOINT ["tini", "--"]
CMD ["./validator"]
