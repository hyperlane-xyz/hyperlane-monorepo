#!/bin/bash
# Checks if @hyperlane-xyz/core has a changeset at or above the required level
# Usage: check-solidity-changeset.sh <required-level>
# Levels: patch < minor < major
# Exit 0 if adequate changeset exists, exit 1 otherwise

set -euo pipefail

REQUIRED_LEVEL=${1:-}
PACKAGE="@hyperlane-xyz/core"

if [ -z "$REQUIRED_LEVEL" ]; then
  echo "Usage: check-solidity-changeset.sh <patch|minor|major>"
  exit 1
fi

# Map levels to numeric values for comparison
level_to_num() {
  case "$1" in
  patch) echo 1 ;;
  minor) echo 2 ;;
  major) echo 3 ;;
  *) echo 0 ;;
  esac
}

REQUIRED_NUM=$(level_to_num "$REQUIRED_LEVEL")
FOUND_LEVEL=""
FOUND_NUM=0

# Scan all changeset files (excluding README.md and config.json)
for file in .changeset/*.md; do
  [ -f "$file" ] || continue
  [[ "$(basename "$file")" == "README.md" ]] && continue

  # Extract the bump level for @hyperlane-xyz/core from YAML frontmatter
  # Handles both quoted and unquoted package names
  LEVEL=$(sed -n '/^---$/,/^---$/p' "$file" | grep -E "^['\"]?${PACKAGE}['\"]?:" | sed "s/.*: *//" | tr -d "'" | tr -d '"' || true)

  if [ -n "$LEVEL" ]; then
    LEVEL_NUM=$(level_to_num "$LEVEL")
    if [ "$LEVEL_NUM" -gt "$FOUND_NUM" ]; then
      FOUND_NUM=$LEVEL_NUM
      FOUND_LEVEL=$LEVEL
    fi
  fi
done

if [ "$FOUND_NUM" -ge "$REQUIRED_NUM" ]; then
  echo "Found $PACKAGE changeset with '$FOUND_LEVEL' bump (required: $REQUIRED_LEVEL or higher)"
  exit 0
else
  if [ -n "$FOUND_LEVEL" ]; then
    echo "Found $PACKAGE changeset with '$FOUND_LEVEL' bump, but '$REQUIRED_LEVEL' or higher is required"
  else
    echo "No changeset found for $PACKAGE (required: $REQUIRED_LEVEL or higher)"
  fi
  echo ""
  echo "To fix this, run 'pnpm changeset' and select '$PACKAGE' with a '$REQUIRED_LEVEL' (or higher) bump."
  exit 1
fi
