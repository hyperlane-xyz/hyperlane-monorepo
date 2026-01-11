FROM debian:11-slim AS base

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git \
    build-essential \
    llvm clang cmake pkg-config \
    libssl-dev libudev-dev zlib1g-dev \
    libprotobuf-dev protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Install Rust

ARG RUST_VERSION=1.75.0
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH

ADD --chmod=755 https://sh.rustup.rs /root/rustup.sh
RUN /root/rustup.sh --default-toolchain $RUST_VERSION \
    --profile minimal -c clippy,rustfmt \
    --no-modify-path -y

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo install --locked sccache
ENV RUSTC_WRAPPER=sccache SCCACHE_DIR=/sccache

# Build Solana

FROM base AS builder
ENV GIT_ADVICE=0
ARG SOLANA_VERSION=1.18.26
ARG SPL_TOKEN_VERSION=3.4.1
WORKDIR /usr/local/src/solana
RUN git clone --depth 1 --branch v$SOLANA_VERSION https://github.com/solana-labs/solana.git .
RUN test -f scripts/spl-token-cli-version.sh && \
sed -i "s/^splTokenCliVersion=.*/splTokenCliVersion=$SPL_TOKEN_VERSION/" scripts/spl-token-cli-version.sh || true

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=$SCCACHE_DIR,sharing=locked \
    ./scripts/cargo-install-all.sh /usr/local/solana

# Final image

FROM base AS runner
ENV PATH=/usr/local/solana/bin:$PATH

COPY --from=builder /usr/local/solana /usr/local/solana

WORKDIR /usr/local/src
