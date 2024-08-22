# syntax=docker/dockerfile:experimental

FROM rust:1.72.1 as builder
WORKDIR /usr/src

# Step 1: Prepare for static linking and install necessary tools
RUN apt-get update && \
    apt-get dist-upgrade -y && \
    apt-get install -y musl-tools clang && \
    rustup target add x86_64-unknown-linux-musl

RUN mkdir rust

# Step 2: Copy the actual source code
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

# Step 3: Build binaries
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

# Step 4: Set up the release image
FROM ubuntu:22.04
RUN apt-get update && \
    apt-get install -y \
        openssl \
        ca-certificates \
        tini && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /release/* .

# Step 5: Copy config files
COPY rust/config ./config

# Step 6: Set up permissions and directories
RUN chmod 777 /app &&  \
    mkdir /usr/share/hyperlane/ && \
    chmod 1000 /usr/share/hyperlane && \
    mkdir /data/ && \
    chown -R 1000 /data/

# Step 7: Set up the user and entrypoint
USER 1000
ENTRYPOINT ["tini", "--"]
CMD ["./validator"]
