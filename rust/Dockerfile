# syntax=docker/dockerfile:1.4
# Dockerfile for multi-stage build of Hyperlane's Rust components
# https://docs.docker.com/build/building/multi-stage/#use-multi-stage-builds
# https://depot.dev/docs/container-builds/how-to-guides/optimal-dockerfiles/rust-dockerfile
#
# Uses cargo-chef for optimal layer caching:
# https://github.com/LukeMathWalker/cargo-chef
# This separates dependency compilation from source compilation, so dependencies
# (including heavy ones like snarkvm) are only rebuilt when Cargo.toml/Cargo.lock change.

# -------- Chef Stage --------
# Base image with cargo-chef installed for dependency caching
FROM rust:1.88.0 AS chef
RUN apt-get update && \
    apt-get install -y --no-install-recommends musl-tools clang && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    rustup target add x86_64-unknown-linux-musl && \
    cargo install --locked cargo-chef sccache

# Configure sccache for faster builds
# https://github.com/mozilla/sccache
ENV RUSTC_WRAPPER=sccache
ENV SCCACHE_DIR=/sccache

WORKDIR /usr/src/rust

# -------- Planner Stage --------
# Analyzes the project and creates a recipe.json with dependency info
FROM chef AS planner

# Copy workspace structure for both main and sealevel
COPY rust/main ./main
COPY rust/sealevel ./sealevel

WORKDIR /usr/src/rust/main
RUN cargo chef prepare --recipe-path /recipe.json

# -------- Builder Stage --------
# Builds dependencies first (cached), then source code
FROM chef AS builder

# Copy the recipe (dependency specification only)
COPY --from=planner /recipe.json /recipe.json

# Copy sealevel workspace (needed for path dependencies)
COPY rust/sealevel ./sealevel

WORKDIR /usr/src/rust/main

# Build dependencies only - this layer is cached until Cargo.toml/Cargo.lock change
# This is where snarkvm and other heavy deps are compiled
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=$SCCACHE_DIR,sharing=locked \
    RUSTFLAGS="--cfg tokio_unstable" \
    cargo chef cook --release --recipe-path /recipe.json

# Now copy the actual source code
COPY rust/main ./

# Copy git metadata for version information
# Required by vergen for build-time git information
COPY .git /usr/src/.git

# Build the release binaries - only recompiles source, not dependencies
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
