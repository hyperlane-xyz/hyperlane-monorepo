#!/bin/bash
# Codex setup — installs Foundry, gh CLI, gitleaks on top of codex-universal
set -euo pipefail

export NVM_DIR="${NVM_DIR:-/root/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Node 24
nvm use 24
nvm alias default 24
corepack enable pnpm

# Foundry
curl -fsSL https://foundry.paradigm.xyz | bash
export PATH="$HOME/.foundry/bin:$PATH"
foundryup

# GitHub CLI
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update -qq
apt-get install -y -qq --no-install-recommends gh
rm -rf /var/lib/apt/lists/*

# Gitleaks
GITLEAKS_VERSION=8.30.0
ARCH=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')
ARCHIVE="gitleaks_${GITLEAKS_VERSION}_linux_${ARCH}.tar.gz"
curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${ARCHIVE}" \
  -o "/tmp/${ARCHIVE}"
tar -xzf "/tmp/${ARCHIVE}" -C /tmp
install -m 0755 /tmp/gitleaks /usr/local/bin/gitleaks
rm -f "/tmp/${ARCHIVE}" /tmp/gitleaks /tmp/README.md /tmp/LICENSE

# Persist Foundry PATH for agent session
cat >> ~/.bashrc <<'ENVEOF'
export PATH="$HOME/.foundry/bin:$PATH"
ENVEOF

# Install project dependencies
pnpm install
