# Dockerfile — Dev container for web-based coding agents (Cursor, etc.).
#
# Mirrors the cloud-ws configure/ toolchain minus TUI tools and shell niceties.
# Base is Debian 12 to match the GCP image family used for VMs.
#
# Included:
#   System  : git, curl, unzip, build-essential, ripgrep, jq, openssh-client
#   Node.js : nodenv + LTS, bun, pnpm (via corepack)
#   Rust    : rustup + stable toolchain
#   Solidity: Foundry (forge, cast, anvil, chisel)
#   CLIs    : gh (GitHub), gitleaks
#
# Build:
#   docker build -t cloud-ws-agent .
#
# Run (mount your project and pass API keys):
#   docker run --rm -it \
#     -v "$PWD:/workspace" \
#     -e ANTHROPIC_API_KEY \
#     cloud-ws-agent bash

FROM debian:12-slim AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV LC_ALL=C

# System packages — matches install-cli-tools.sh (minus tmux, fzf, starship)
# plus jq for JSON processing and openssh-client for git+ssh.
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      git \
      curl \
      ca-certificates \
      gnupg \
      unzip \
      build-essential \
      ripgrep \
      jq \
      openssh-client \
      python3 \
      procps \
    && rm -rf /var/lib/apt/lists/*

# --------------------------------------------------------------------------
# GitHub CLI — matches install-gh.sh
# --------------------------------------------------------------------------
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# --------------------------------------------------------------------------
# Non-root user
# --------------------------------------------------------------------------
ARG USERNAME=user
ARG USER_UID=1000
ARG USER_GID=1000

RUN groupadd --gid "$USER_GID" "$USERNAME" && \
    useradd --uid "$USER_UID" --gid "$USER_GID" -m -s /bin/bash "$USERNAME"

USER $USERNAME
WORKDIR /home/$USERNAME

# --------------------------------------------------------------------------
# nodenv + Node.js LTS — matches setup-node-ecosystem.sh
# --------------------------------------------------------------------------
ENV NODENV_ROOT="/home/$USERNAME/.nodenv"
ENV PATH="$NODENV_ROOT/shims:$NODENV_ROOT/bin:$PATH"

RUN git clone -q https://github.com/nodenv/nodenv.git "$NODENV_ROOT" && \
    git clone -q https://github.com/nodenv/node-build.git "$NODENV_ROOT/plugins/node-build" && \
    git clone -q https://github.com/nodenv/nodenv-aliases.git "$NODENV_ROOT/plugins/nodenv-aliases" && \
    git clone -q https://github.com/nodenv/nodenv-nvmrc.git "$NODENV_ROOT/plugins/nodenv-nvmrc"

# Install the latest Node 24.x that node-build knows about, set as global default.
# Rebuild the image to pick up new versions (after node-build plugin updates).
RUN NODE_VER=$(ls "$NODENV_ROOT/plugins/node-build/share/node-build/" \
      | grep -E '^24\.' | sort -V | tail -1) && \
    nodenv install "$NODE_VER" && \
    nodenv global "$NODE_VER" && \
    nodenv rehash && \
    corepack enable pnpm && \
    corepack prepare pnpm@latest --activate && \
    nodenv rehash

# --------------------------------------------------------------------------
# bun — matches setup-node-ecosystem.sh
# --------------------------------------------------------------------------
ENV BUN_INSTALL="/home/$USERNAME/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

RUN curl -fsSL https://bun.sh/install | bash

# --------------------------------------------------------------------------
# pnpm global bin — matches setup-node-ecosystem.sh
# --------------------------------------------------------------------------
ENV PNPM_HOME="/home/$USERNAME/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN mkdir -p "$PNPM_HOME"

# --------------------------------------------------------------------------
# Rust — matches setup-rust.sh
# --------------------------------------------------------------------------
ENV CARGO_HOME="/home/$USERNAME/.cargo"
ENV RUSTUP_HOME="/home/$USERNAME/.rustup"
ENV PATH="$CARGO_HOME/bin:$PATH"

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --no-modify-path

# --------------------------------------------------------------------------
# Foundry — matches install-blockchain-tools.sh
# --------------------------------------------------------------------------
ENV PATH="/home/$USERNAME/.foundry/bin:$PATH"

RUN curl -fsSL https://foundry.paradigm.xyz | bash && \
    foundryup

# --------------------------------------------------------------------------
# Gitleaks — matches install-gitleaks.sh
# --------------------------------------------------------------------------
ENV PATH="/home/$USERNAME/.local/bin:$PATH"
ARG GITLEAKS_VERSION=8.30.0

RUN mkdir -p /home/$USERNAME/.local/bin && \
    ARCH=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/') && \
    ARCHIVE="gitleaks_${GITLEAKS_VERSION}_linux_${ARCH}.tar.gz" && \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${ARCHIVE}" \
      -o "/tmp/${ARCHIVE}" && \
    tar -xzf "/tmp/${ARCHIVE}" -C /tmp && \
    install -m 0755 /tmp/gitleaks /home/$USERNAME/.local/bin/gitleaks && \
    rm -f "/tmp/${ARCHIVE}" /tmp/gitleaks /tmp/README.md /tmp/LICENSE

# --------------------------------------------------------------------------
# Ensure key binaries are visible in non-interactive shells
# --------------------------------------------------------------------------
USER root
RUN ln -sf /home/$USERNAME/.nodenv/shims/node /usr/local/bin/node && \
    ln -sf /home/$USERNAME/.nodenv/shims/pnpm /usr/local/bin/pnpm && \
    ln -sf /home/$USERNAME/.nodenv/bin/corepack /usr/local/bin/corepack
USER $USERNAME

# --------------------------------------------------------------------------
# Final setup
# --------------------------------------------------------------------------
# Keep WORKDIR as the user's home — the agent runner controls where the repo
# is cloned (typically via cwd or volume mount).
WORKDIR /home/$USERNAME

CMD ["bash"]
