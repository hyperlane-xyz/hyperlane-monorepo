#!/usr/bin/env bash
# Update the workspace version in rust/main/Cargo.toml
#
# Usage:
#   update-workspace-version.sh NEW_VERSION
#
# Arguments:
#   NEW_VERSION - The new version to set (e.g., "1.5.0")
#
# Returns:
#   Updates rust/main/Cargo.toml in place
#
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Error: NEW_VERSION is required" >&2
  echo "Usage: $0 NEW_VERSION" >&2
  exit 1
fi

NEW_VERSION="$1"

# Determine script directory and repo structure
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_MAIN_DIR="$SCRIPT_DIR/../main"
CARGO_TOML="$RUST_MAIN_DIR/Cargo.toml"

# Use awk to find [workspace.package] section and update version within it
awk -v new_version="$NEW_VERSION" '
  /^\[workspace\.package\]/ { in_workspace=1 }
  /^\[/ && !/^\[workspace\.package\]/ { in_workspace=0 }
  in_workspace && /^version = / {
    print "version = \"" new_version "\""
    next
  }
  { print }
' "$CARGO_TOML" > "$CARGO_TOML.new"

mv "$CARGO_TOML.new" "$CARGO_TOML"

echo "Updated $CARGO_TOML to version $NEW_VERSION"
