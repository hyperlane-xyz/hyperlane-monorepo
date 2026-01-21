# Reproducible Solana Program Build Environment
# Based on solana-verifiable-build v1.14.20 configuration
# Reference: https://github.com/Ellipsis-Labs/solana-verifiable-build

# Pinned Rust 1.68.0 image (required for Solana 1.14.x)
# This exact digest ensures reproducible builds across time
# Platform is intentionally hardcoded for reproducibility (not a variable)
# check=skip=FromPlatformFlagConstDisallowed
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
# Download release tarball directly and verify SHA256 for full reproducibility
# Note: Platform is locked to linux/amd64 above, so we hardcode x86_64
ENV SOLANA_VERSION=v1.14.20
ARG SOLANA_RELEASE_SHA256=8d9feed221bf352a544b15b7a7e74fed877da7c4aa0458b9a33fd7ce3099ad54
RUN SOLANA_INSTALL_DIR="/root/.local/share/solana/install/releases/${SOLANA_VERSION}" && \
    mkdir -p "$SOLANA_INSTALL_DIR" && \
    curl -sSfL "https://github.com/solana-labs/solana/releases/download/${SOLANA_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" -o /tmp/solana-release.tar.bz2 && \
    echo "${SOLANA_RELEASE_SHA256}  /tmp/solana-release.tar.bz2" | sha256sum -c - && \
    tar -xjf /tmp/solana-release.tar.bz2 -C "$SOLANA_INSTALL_DIR" --strip-components=1 && \
    rm /tmp/solana-release.tar.bz2 && \
    ln -sf "$SOLANA_INSTALL_DIR" /root/.local/share/solana/install/active_release

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

# Use git CLI for fetching to avoid libgit2 memory issues with large repos
ENV CARGO_NET_GIT_FETCH_WITH_CLI=true

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
