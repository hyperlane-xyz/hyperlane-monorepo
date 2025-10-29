#!/usr/bin/env bash
# Extract the version from rust/main/Cargo.toml workspace.package.version
#
# Usage:
#   get-workspace-version.sh
#
# Returns:
#   The current workspace version (e.g., "1.4.0")
#
set -euo pipefail

# Determine script directory and repo structure
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_MAIN_DIR="$SCRIPT_DIR/../../main"

grep -A 10 '^\[workspace\.package\]' "$RUST_MAIN_DIR/Cargo.toml" | \
  grep '^version = ' | \
  head -1 | \
  sed 's/version = "\(.*\)"/\1/'
