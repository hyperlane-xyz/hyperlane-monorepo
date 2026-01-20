# Hyperlane Development Container
# Uses pre-built monorepo image from GCR as base
FROM gcr.io/abacus-labs-dev/hyperlane-monorepo:main

# Install dev tools not in base image
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    gh \
    zsh \
    fzf \
    sudo \
    vim \
    nano \
    iptables \
    ipset \
    iproute2 \
    dnsutils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create node user if it doesn't exist and set up permissions
RUN id -u node &>/dev/null || useradd -m -s /bin/zsh node \
    && mkdir -p /home/node/.opencode /commandhistory \
    && chown -R node:node /home/node /commandhistory \
    && echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node

# Install OpenCode CLI
RUN npm install -g opencode-ai

# Copy firewall script
COPY init-firewall.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/init-firewall.sh

# Switch to node user
USER node
WORKDIR /hyperlane-monorepo

# Set shell to zsh
ENV SHELL=/bin/zsh
ENV EDITOR=nano
ENV VISUAL=nano
