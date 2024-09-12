# syntax=docker/dockerfile:experimental

FROM rust:1.72.1 as builder
WORKDIR /usr/src

# 1a: Prepare for static linking
RUN apt-get update && \
    apt-get dist-upgrade -y && \
    apt-get install -y musl-tools clang && \
    rustup target add x86_64-unknown-linux-musl

RUN mkdir rust

# Add workspace to workdir
COPY rust/agents rust/agents
COPY rust/chains rust/chains
COPY rust/hyperlane-base rust/hyperlane-base
COPY rust/hyperlane-core rust/hyperlane-core
COPY rust/hyperlane-test rust/hyperlane-test
COPY rust/ethers-prometheus rust/ethers-prometheus
COPY rust/utils rust/utils
COPY rust/sealevel rust/sealevel

COPY rust/Cargo.toml rust/.
COPY rust/Cargo.lock rust/.

COPY .git .git

WORKDIR /usr/src/rust

# Build binaries
RUN \
  --mount=id=cargo,type=cache,sharing=locked,target=/usr/src/target \
  --mount=id=cargo-home-registry,type=cache,sharing=locked,target=/usr/local/cargo/registry \
  --mount=id=cargo-home-git,type=cache,sharing=locked,target=/usr/local/cargo/git \
    RUSTFLAGS="--cfg tokio_unstable" cargo build --release --bin validator --bin relayer --bin scraper && \
    mkdir -p /release && \
    cp /usr/src/rust/target/release/validator /release && \
    cp /usr/src/rust/target/release/relayer /release && \
    cp /usr/src/rust/target/release/scraper /release

## 2: Copy the binaries to release image
FROM ubuntu:22.04
RUN apt-get update && \
    apt-get install -y \
        openssl \
        ca-certificates \
        tini && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY rust/config ./config
COPY --from=builder /release/* .

RUN chmod 777 /app &&  \
    mkdir /usr/share/hyperlane/ && \
    chmod 1000 /usr/share/hyperlane && \
    mkdir /data/ && \
    chown -R 1000 /data/

USER 1000
ENTRYPOINT ["tini", "--"]
CMD ["./validator"]
