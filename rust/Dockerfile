# syntax=docker/dockerfile:experimental

FROM rust:1.56 as builder
WORKDIR /usr/src

# 1a: Prepare for static linking
RUN apt-get update && \
    apt-get dist-upgrade -y && \
    apt-get install -y musl-tools clang && \
    rustup target add x86_64-unknown-linux-musl

# Add workspace to workdir 
COPY agents ./agents
COPY chains ./chains
COPY tools ./tools
COPY abacus-base ./abacus-base 
COPY abacus-core ./abacus-core
COPY abacus-test ./abacus-test

COPY Cargo.toml .
COPY Cargo.lock .

# Build binaries
RUN --mount=id=cargo,type=cache,target=/usr/src/target \
  --mount=id=cargo-home-registry,type=cache,target=/usr/local/cargo/registry \
  --mount=id=cargo-home-git,type=cache,target=/usr/local/cargo/git \
    cargo build --release

# Copy artifacts out of volume
WORKDIR /release 
RUN --mount=id=cargo,type=cache,target=/usr/src/target  cp /usr/src/target/release/validator .
RUN --mount=id=cargo,type=cache,target=/usr/src/target  cp /usr/src/target/release/relayer .
RUN --mount=id=cargo,type=cache,target=/usr/src/target  cp /usr/src/target/release/kathy .
RUN --mount=id=cargo,type=cache,target=/usr/src/target  cp /usr/src/target/release/kms-cli .
RUN --mount=id=cargo,type=cache,target=/usr/src/target  cp /usr/src/target/release/abacus-cli .

# 2: Copy the binaries to release image
FROM ubuntu:20.04
RUN apt-get update && \
    apt-get install -y libssl-dev \
    ca-certificates

WORKDIR /app
COPY --from=builder /release/validator .
COPY --from=builder /release/relayer .
COPY --from=builder /release/kathy .
COPY --from=builder /release/kms-cli .
COPY --from=builder /release/abacus-cli .
COPY config ./config
RUN chmod 777 /app
RUN mkdir /usr/share/abacus/ && chmod 1000 /usr/share/abacus
USER 1000
CMD ["./validator"]