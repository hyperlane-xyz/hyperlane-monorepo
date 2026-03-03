#!/bin/bash
# Codex maintenance — re-install deps on resumed containers
set -euo pipefail

export NVM_DIR="${NVM_DIR:-/root/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

pnpm install
