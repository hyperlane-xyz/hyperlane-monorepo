# Reproducible Solana Program Build Environment
# Builds Sealevel programs using Agave CLI v3.0.14 with platform-tools v1.51

# Pinned Rust 1.86.0-bookworm image (matches rust/sealevel/rust-toolchain)
# Uses bookworm (Debian 12) which provides GLIBC 2.36 required by Agave v3.x
# (bullseye only has GLIBC 2.31, insufficient for Agave v3.0.14)
# This exact digest ensures reproducible builds across time
# Platform is intentionally hardcoded for reproducibility (not a variable)
# check=skip=FromPlatformFlagConstDisallowed
FROM --platform=linux/amd64 rust@sha256:300ec56abce8cc9448ddea2172747d048ed902a3090e6b57babb2bf19f754081 AS builder

# Install dependencies with pinned versions for reproducibility
# Note: git and curl are pre-installed in the pinned base image.
# Only gnutls-bin needs to be installed. Version from Debian 12 bookworm-security repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnutls-bin=3.7.9-2+deb12u6 \
    && rm -rf /var/lib/apt/lists/*

# Reproducibility environment variables
# SOURCE_DATE_EPOCH=0 ensures timestamps are deterministic
# CARGO_INCREMENTAL=0 disables incremental compilation for reproducibility
ENV SOURCE_DATE_EPOCH=0
ENV CARGO_INCREMENTAL=0
ENV RUSTFLAGS="--cfg tokio_unstable"

# Install Agave CLI v3.0.14 (formerly Solana CLI, now maintained by Anza)
# Download release tarball directly and verify SHA256 for full reproducibility
# Note: Platform is locked to linux/amd64 above, so we hardcode x86_64
ENV SOLANA_VERSION=v3.0.14
ARG SOLANA_RELEASE_SHA256=65614325423316a48f57f1ceeaa91ca78f4516e165e305b38c01873cf8c6b8b4
RUN SOLANA_INSTALL_DIR="/root/.local/share/solana/install/releases/${SOLANA_VERSION}" && \
    mkdir -p "$SOLANA_INSTALL_DIR" && \
    curl -sSfL "https://github.com/anza-xyz/agave/releases/download/${SOLANA_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" -o /tmp/solana-release.tar.bz2 && \
    echo "${SOLANA_RELEASE_SHA256}  /tmp/solana-release.tar.bz2" | sha256sum -c - && \
    tar -xjf /tmp/solana-release.tar.bz2 -C "$SOLANA_INSTALL_DIR" --strip-components=1 && \
    rm /tmp/solana-release.tar.bz2 && \
    ln -sf "$SOLANA_INSTALL_DIR" /root/.local/share/solana/install/active_release

# Add Solana to PATH
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"

# Verify installation
RUN solana --version && cargo --version && rustc --version

# Pre-download platform-tools with checksum verification
# This ensures reproducibility even if GitHub releases are modified
# Check version with: cargo build-sbf --version (shows "platform-tools vX.XX")
# Agave v3.x caches platform-tools by their own version (not CLI version)
ARG BPF_TOOLS_VERSION=v1.51
ARG BPF_TOOLS_SHA256=0933e05dd964826e8e2db5c58c34ae255e3baf0ce1711568552dca81b5407a6b
RUN BPF_TOOLS_URL="https://github.com/anza-xyz/platform-tools/releases/download/${BPF_TOOLS_VERSION}/platform-tools-linux-x86_64.tar.bz2" && \
    CACHE_DIR="/root/.cache/solana/${BPF_TOOLS_VERSION}/platform-tools" && \
    mkdir -p "$CACHE_DIR" && \
    curl --retry 5 --retry-delay 5 --retry-all-errors -fsSL "$BPF_TOOLS_URL" -o /tmp/bpf-tools.tar.bz2 && \
    echo "${BPF_TOOLS_SHA256}  /tmp/bpf-tools.tar.bz2" | sha256sum -c - && \
    tar -xjf /tmp/bpf-tools.tar.bz2 -C "$CACHE_DIR" && \
    rm /tmp/bpf-tools.tar.bz2

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
