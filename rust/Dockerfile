# syntax=docker/dockerfile:experimental

FROM rust:1.67.1 as builder
WORKDIR /usr/src

# 1a: Prepare for static linking
RUN apt-get update && \
    apt-get dist-upgrade -y && \
    apt-get install -y musl-tools clang && \
    rustup target add x86_64-unknown-linux-musl

# Add workspace to workdir 
COPY agents ./agents
COPY chains ./chains
COPY hyperlane-base ./hyperlane-base 
COPY hyperlane-core ./hyperlane-core
COPY hyperlane-test ./hyperlane-test
COPY ethers-prometheus ./ethers-prometheus
COPY gelato ./gelato
COPY utils ./utils

COPY Cargo.toml .
COPY Cargo.lock .

# Build binaries
RUN \
  --mount=id=cargo,type=cache,sharing=locked,target=/usr/src/target \
  --mount=id=cargo-home-registry,type=cache,sharing=locked,target=/usr/local/cargo/registry \
  --mount=id=cargo-home-git,type=cache,sharing=locked,target=/usr/local/cargo/git \
    cargo build --release && \
    mkdir -p /release && \
    cp /usr/src/target/release/validator /release && \
    cp /usr/src/target/release/relayer /release && \
    cp /usr/src/target/release/scraper /release

## 2: Copy the binaries to release image
FROM ubuntu:20.04
RUN apt-get update && \
    apt-get install -y \
        openssl \
        ca-certificates \
        tini && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY config ./config
COPY --from=builder /release/* .

RUN chmod 777 /app &&  \
    mkdir /usr/share/hyperlane/ && \
    chmod 1000 /usr/share/hyperlane

USER 1000
ENTRYPOINT ["tini", "--"]
CMD ["./validator"]
