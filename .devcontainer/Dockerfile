# Hyperlane Development Container
# Uses Node.js base with Foundry pre-installed
FROM ghcr.io/foundry-rs/foundry:latest AS foundry

FROM node:22-bookworm

# Copy Foundry binaries
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/
COPY --from=foundry /usr/local/bin/chisel /usr/local/bin/

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gh \
    zsh \
    fzf \
    sudo \
    vim \
    nano \
    git \
    curl \
    jq \
    iptables \
    ipset \
    iproute2 \
    dnsutils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Create node user home directories and permissions
RUN mkdir -p /home/node/.opencode /commandhistory \
    && chown -R node:node /home/node /commandhistory \
    && echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node

# Install OpenCode CLI globally
RUN npm install -g opencode-ai

# Copy firewall script
COPY init-firewall.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/init-firewall.sh

# Switch to node user
USER node
WORKDIR /workspaces/hyperlane-monorepo

# Set shell to zsh
ENV SHELL=/bin/zsh
ENV EDITOR=nano
ENV VISUAL=nano
