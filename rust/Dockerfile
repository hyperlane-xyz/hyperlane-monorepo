# syntax=docker/dockerfile:1.4
# Dockerfile for multi-stage build of Hyperlane's Rust components
# https://docs.docker.com/build/building/multi-stage/#use-multi-stage-builds
# https://depot.dev/docs/container-builds/how-to-guides/optimal-dockerfiles/rust-dockerfile

# -------- Base Image with Tools --------
# Base image containing all necessary build tools and dependencies
FROM rust:1.81.0 AS base
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

# -------- Builder Stage --------
# This stage compiles the Rust binaries
FROM base AS builder

# Set up the workspace structure
WORKDIR /usr/src/rust/main

# Copy git metadata for version information
# Required by vergen for build-time git information
COPY .git ../../.git

# Copy all main workspace crates
# Each directory represents a different component of the Hyperlane system
COPY rust/main/agents ./agents
COPY rust/main/applications ./applications
COPY rust/main/chains ./chains
COPY rust/main/ethers-prometheus ./ethers-prometheus
COPY rust/main/hyperlane-base ./hyperlane-base
COPY rust/main/hyperlane-core ./hyperlane-core
COPY rust/main/hyperlane-metric ./hyperlane-metric
COPY rust/main/hyperlane-test ./hyperlane-test
COPY rust/main/lander ./lander
COPY rust/main/utils ./utils
COPY rust/main/Cargo.toml ./
COPY rust/main/Cargo.lock ./

# Copy sealevel workspace into correct relative location
COPY rust/sealevel ../sealevel

# Build the release binaries with caching enabled
# Documentation: https://doc.rust-lang.org/cargo/commands/cargo-build.html
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
COPY --from=builder /release/* .

# Install runtime dependencies
# remove /var/lib/apt/lists/* to clean up the package lists
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates tini && \
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
