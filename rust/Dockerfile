# syntax=docker/dockerfile:1.4
# Dockerfile for multi-stage build of Hyperlane's Rust components
# https://docs.docker.com/build/building/multi-stage/#use-multi-stage-builds
# https://depot.dev/docs/container-builds/how-to-guides/optimal-dockerfiles/rust-dockerfile
#
# This Dockerfile supports building individual agent images or a combined image:
#   - hyperlane-validator: validator binary only (~200 MB)
#   - hyperlane-relayer: relayer binary only (~215 MB)
#   - hyperlane-scraper: scraper binary only (~140 MB)
#   - hyperlane-agent: all binaries (~580 MB, backwards compatible)
#
# Build targets:
#   docker build --target validator -t hyperlane-validator .
#   docker build --target relayer -t hyperlane-relayer .
#   docker build --target scraper -t hyperlane-scraper .
#   docker build --target agent -t hyperlane-agent .  # or just: docker build .

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
    cp target/release/scraper /release && \
    strip /release/*

# -------- Runtime Base --------
# Common runtime setup shared by all images
# Using debian-slim instead of Alpine because Rust binaries are linked against glibc
FROM debian:bookworm-slim AS runtime-base
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates tini libcurl4 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /app /usr/share/hyperlane /data && \
    chmod 777 /app && \
    chmod 1000 /usr/share/hyperlane && \
    chown -R 1000 /data

WORKDIR /app
COPY rust/main/config /app/config
COPY rust/main/app-contexts /app/app-contexts

# Run as non-root user for security
USER 1000
# Use tini as init system for proper process management
ENTRYPOINT ["tini", "--"]

# -------- Individual Agent Images --------
# Each target produces a minimal image with only the required binary

# Validator-only image (~200 MB)
# Used by: ~140 validator pods in production
FROM runtime-base AS validator
COPY --from=builder /release/validator .
CMD ["./validator"]

# Relayer-only image (~215 MB)
# Used by: ~2 relayer pods in production
FROM runtime-base AS relayer
COPY --from=builder /release/relayer .
CMD ["./relayer"]

# Scraper-only image (~140 MB)
# Used by: ~1 scraper pod in production
FROM runtime-base AS scraper
COPY --from=builder /release/scraper .
CMD ["./scraper"]

# -------- Combined Agent Image (default) --------
# All binaries in one image for backwards compatibility
# This is the default target when no --target is specified
FROM runtime-base AS agent
COPY --from=builder /release/* .
CMD ["./validator"]
