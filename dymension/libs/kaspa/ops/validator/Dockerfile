FROM rust:1.75 as builder

# Install dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    pkg-config \
    libssl-dev \
    protobuf-compiler \
    git \
    clang \
    libclang-dev \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Configure git to use libcurl for better SSL handling
RUN git config --global http.postBuffer 524288000 && \
    git config --global http.sslVerify true && \
    git config --global http.lowSpeedLimit 0 && \
    git config --global http.lowSpeedTime 999999

# Configure cargo to use git CLI for fetching (better SSL handling)
RUN mkdir -p ~/.cargo && \
    echo '[net]' >> ~/.cargo/config.toml && \
    echo 'git-fetch-with-cli = true' >> ~/.cargo/config.toml

# Set working directory
WORKDIR /workspace

# Copy the entire repository (maintains full directory structure)
# This is needed because rust/main workspace depends on /dymension, /sealevel, etc.
COPY . .

# Build validator from rust/main directory
WORKDIR /workspace/rust/main
RUN cargo build --release --bin validator

# Runtime image
FROM debian:bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy binary from builder
COPY --from=builder /workspace/rust/main/target/release/validator /usr/local/bin/validator

# Copy Kaspa wallet file
RUN mkdir -p /root/.kaspa
COPY --from=builder /workspace/dymension/libs/kaspa/ops/validator/kaspa.mainnet.wallet /root/.kaspa/kaspa.wallet

# Create app directory
WORKDIR /app

# Expose metrics port
EXPOSE 9090

# Run validator
CMD ["validator"]