# Reproducible Solana Program Build Environment
# Based on solana-verifiable-build v1.14.20 configuration
# Reference: https://github.com/Ellipsis-Labs/solana-verifiable-build

# Pinned Rust 1.68.0 image (required for Solana 1.14.x)
# This exact digest ensures reproducible builds across time
FROM --platform=linux/amd64 rust@sha256:79892de83d1af9109c47a4566a24a0b240348bb8c088f1bccc52645c4c70ec39 AS builder

# Install dependencies
RUN apt-get update && apt-get install -y \
    git \
    gnutls-bin \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Reproducibility environment variables
# SOURCE_DATE_EPOCH=0 ensures timestamps are deterministic
# CARGO_INCREMENTAL=0 disables incremental compilation for reproducibility
ENV SOURCE_DATE_EPOCH=0
ENV CARGO_INCREMENTAL=0
ENV RUSTFLAGS="--cfg tokio_unstable"

# Install Solana CLI v1.14.20
# Download directly from GitHub releases (more reliable than release.solana.com)
ENV SOLANA_VERSION=v1.14.20
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then TARGET="x86_64-unknown-linux-gnu"; \
    elif [ "$ARCH" = "aarch64" ]; then TARGET="aarch64-unknown-linux-gnu"; \
    else echo "Unsupported architecture: $ARCH" && exit 1; fi && \
    curl -sSfL "https://github.com/solana-labs/solana/releases/download/${SOLANA_VERSION}/solana-install-init-${TARGET}" -o /tmp/solana-install-init && \
    chmod +x /tmp/solana-install-init && \
    /tmp/solana-install-init ${SOLANA_VERSION} && \
    rm /tmp/solana-install-init

# Add Solana to PATH
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

# Verify installation
RUN solana --version && cargo --version && rustc --version

# Pre-download BPF SDK/platform-tools with checksum verification
# This ensures reproducibility even if GitHub releases are modified
# Check version with: cargo build-sbf --version (shows "sbf-tools vX.XX")
# Note: solana-labs/platform-tools moved to anza-xyz/platform-tools
ARG BPF_TOOLS_VERSION=v1.29
ARG BPF_TOOLS_SHA256=61ab3485168129eb2392efa4e2c7781435c9825f07c19822e46bcf5a2cd8a8d2
ARG CRITERION_VERSION=v2.3.3
ARG CRITERION_SHA256=ee7f92d7268563848aa3ae90bbf5df86604b8d0fb0e4942b0ecfbf6201596550
RUN BPF_TOOLS_URL="https://github.com/anza-xyz/platform-tools/releases/download/${BPF_TOOLS_VERSION}/solana-bpf-tools-linux.tar.bz2" && \
    CRITERION_URL="https://github.com/Snaipe/Criterion/releases/download/${CRITERION_VERSION}/criterion-${CRITERION_VERSION}-linux-x86_64.tar.bz2" && \
    CACHE_DIR="/root/.cache/solana/${SOLANA_VERSION}/platform-tools" && \
    mkdir -p "$CACHE_DIR" && \
    curl --retry 5 --retry-delay 5 --retry-all-errors -fsSL "$BPF_TOOLS_URL" -o /tmp/bpf-tools.tar.bz2 && \
    echo "${BPF_TOOLS_SHA256}  /tmp/bpf-tools.tar.bz2" | sha256sum -c - && \
    curl --retry 5 --retry-delay 5 --retry-all-errors -fsSL "$CRITERION_URL" -o /tmp/criterion.tar.bz2 && \
    echo "${CRITERION_SHA256}  /tmp/criterion.tar.bz2" | sha256sum -c - && \
    tar -xjf /tmp/bpf-tools.tar.bz2 -C "$CACHE_DIR" && \
    tar -xjf /tmp/criterion.tar.bz2 -C "$CACHE_DIR" && \
    rm /tmp/bpf-tools.tar.bz2 /tmp/criterion.tar.bz2

WORKDIR /build

# Copy the entire rust directory (both main and sealevel workspaces)
# .dockerignore excludes **/target so build artifacts won't be copied
COPY rust rust

# Use shallow git clones to reduce memory usage when fetching large repos (like solana.git)
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
RUN git config --global fetch.depth 1

# Fetch all dependencies first with --locked to ensure reproducibility
# This pre-populates the cargo cache so cargo-build-sbf doesn't try to update
WORKDIR /build/rust/sealevel
RUN cargo fetch --locked

# Set working directory to programs
WORKDIR /build/rust/sealevel/programs

# Build argument for program type (all, core, token)
ARG PROGRAM_TYPE=all

# Enable locked builds for reproducibility
ENV CARGO_BUILD_SBF_LOCKED=1

# Build programs using the build script
RUN chmod +x build-programs.sh && ./build-programs.sh ${PROGRAM_TYPE}

# Artifacts stage - minimal image with just .so files
FROM scratch AS artifacts
COPY --from=builder /build/rust/sealevel/target/deploy/*.so /programs/
