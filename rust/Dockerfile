# syntax=docker/dockerfile:experimental

FROM rust:1.81.0 as builder
WORKDIR /usr/src

# 1a: Prepare for static linking
RUN apt-get update && \
    apt-get dist-upgrade -y && \
    apt-get install -y musl-tools clang && \
    rustup target add x86_64-unknown-linux-musl

RUN mkdir -p rust/main
RUN mkdir -p rust/sealevel

# Add workspace to workdir
COPY rust/main/agents rust/main/agents
COPY rust/main/applications rust/main/applications
COPY rust/main/chains rust/main/chains
COPY rust/main/hyperlane-base rust/main/hyperlane-base
COPY rust/main/hyperlane-core rust/main/hyperlane-core
COPY rust/main/hyperlane-metric rust/main/hyperlane-metric
COPY rust/main/hyperlane-test rust/main/hyperlane-test
COPY rust/main/ethers-prometheus rust/main/ethers-prometheus
COPY rust/main/utils rust/main/utils
COPY rust/main/submitter rust/main/submitter
COPY rust/sealevel rust/sealevel

COPY rust/main/Cargo.toml rust/main/.
COPY rust/main/Cargo.lock rust/main/.

# Required for VERGEN_GIT_SHA to be populated
COPY .git .git

WORKDIR /usr/src/rust/main

# Build binaries
RUN \
    RUSTFLAGS="--cfg tokio_unstable" cargo build --release --bin validator --bin relayer --bin scraper && \
    mkdir -p /release && \
    cp /usr/src/rust/main/target/release/validator /release && \
    cp /usr/src/rust/main/target/release/relayer /release && \
    cp /usr/src/rust/main/target/release/scraper /release

## 2: Copy the binaries to release image
FROM ubuntu:22.04
RUN apt-get update && \
    apt-get install -y \
        openssl \
        ca-certificates \
        tini && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p /app/config
COPY rust/main/config /app/config
COPY --from=builder /release/* .

RUN chmod 777 /app &&  \
    mkdir /usr/share/hyperlane/ && \
    chmod 1000 /usr/share/hyperlane && \
    mkdir /data/ && \
    chown -R 1000 /data/

USER 1000
ENTRYPOINT ["tini", "--"]
CMD ["./validator"]
