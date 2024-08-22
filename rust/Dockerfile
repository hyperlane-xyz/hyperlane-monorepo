# syntax=docker/dockerfile:experimental

FROM rust:1.72.1 as builder
WORKDIR /usr/src

# Step 1: Prepare for static linking and install necessary tools
RUN apt-get update && \
    apt-get dist-upgrade -y && \
    apt-get install -y musl-tools clang && \
    rustup target add x86_64-unknown-linux-musl

# Step 2: Copy dependency files and create dummy source files
COPY rust/Cargo.toml rust/Cargo.lock ./rust/

# Create dummy source files to build dependencies
RUN mkdir -p rust/src && \
    echo "fn main() {}" > rust/src/main.rs && \
    mkdir -p rust/agents/src && \
    echo "fn main() {}" > rust/agents/src/lib.rs && \
    mkdir -p rust/chains/src && \
    echo "fn main() {}" > rust/chains/src/lib.rs && \
    mkdir -p rust/hyperlane-base/src && \
    echo "fn main() {}" > rust/hyperlane-base/src/lib.rs && \
    mkdir -p rust/hyperlane-core/src && \
    echo "fn main() {}" > rust/hyperlane-core/src/lib.rs && \
    mkdir -p rust/hyperlane-test/src && \
    echo "fn main() {}" > rust/hyperlane-test/src/lib.rs && \
    mkdir -p rust/ethers-prometheus/src && \
    echo "fn main() {}" > rust/ethers-prometheus/src/lib.rs && \
    mkdir -p rust/utils/src && \
    echo "fn main() {}" > rust/utils/src/lib.rs && \
    mkdir -p rust/sealevel/src && \
    echo "fn main() {}" > rust/sealevel/src/lib.rs

# Step 3: Build dependencies
RUN \
  --mount=id=cargo,type=cache,sharing=locked,target=/usr/src/target \
  --mount=id=cargo-home-registry,type=cache,sharing=locked,target=/usr/local/cargo/registry \
  --mount=id=cargo-home-git,type=cache,sharing=locked,target=/usr/local/cargo/git \
    cd rust && \
    RUSTFLAGS="--cfg tokio_unstable" cargo build --release

# Step 4: Copy the actual source code
COPY rust/agents rust/agents
COPY rust/chains rust/chains
COPY rust/hyperlane-base rust/hyperlane-base
COPY rust/hyperlane-core rust/hyperlane-core
COPY rust/hyperlane-test rust/hyperlane-test
COPY rust/ethers-prometheus rust/ethers-prometheus
COPY rust/utils rust/utils
COPY rust/sealevel rust/sealevel
COPY .git .git

# Step 5: Build binaries
RUN \
  --mount=id=cargo,type=cache,sharing=locked,target=/usr/src/target \
  --mount=id=cargo-home-registry,type=cache,sharing=locked,target=/usr/local/cargo/registry \
  --mount=id=cargo-home-git,type=cache,sharing=locked,target=/usr/local/cargo/git \
    cd rust && \
    RUSTFLAGS="--cfg tokio_unstable" cargo build --release --bin validator --bin relayer --bin scraper && \
    mkdir -p /release && \
    cp target/release/validator /release && \
    cp target/release/relayer /release && \
    cp target/release/scraper /release

# Step 6: Set up the release image
FROM ubuntu:22.04
RUN apt-get update && \
    apt-get install -y \
        openssl \
        ca-certificates \
        tini && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /release/* .

# Step 7: Copy config files
COPY rust/config ./config

# Step 8: Set up permissions and directories
RUN chmod 777 /app &&  \
    mkdir /usr/share/hyperlane/ && \
    chmod 1000 /usr/share/hyperlane && \
    mkdir /data/ && \
    chown -R 1000 /data/

# Step 9: Set up the user and entrypoint
USER 1000
ENTRYPOINT ["tini", "--"]
CMD ["./validator"]
