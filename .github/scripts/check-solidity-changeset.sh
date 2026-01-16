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

# Get changeset status as JSON
# Note: changeset status --output requires a path relative to repo root
STATUS_FILE=".changeset-status-$$.json"
trap "rm -f $STATUS_FILE" EXIT
# changeset status exits non-zero when there are pending changesets, so ignore exit code
pnpm changeset status --output "$STATUS_FILE" 2>/dev/null || true

# Extract bump type for the package (only if it has explicit changesets, not transitive)
FOUND_LEVEL=$(jq -r --arg pkg "$PACKAGE" '.releases[] | select(.name == $pkg and (.changesets | length > 0)) | .type' "$STATUS_FILE")

# Map levels to numbers
level_to_num() {
	case "$1" in
	patch) echo 1 ;; minor) echo 2 ;; major) echo 3 ;; *) echo 0 ;;
	esac
}

REQUIRED_NUM=$(level_to_num "$REQUIRED_LEVEL")
FOUND_NUM=$(level_to_num "$FOUND_LEVEL")

if [ "$FOUND_NUM" -ge "$REQUIRED_NUM" ]; then
	echo "Found $PACKAGE changeset with '$FOUND_LEVEL' bump (required: $REQUIRED_LEVEL or higher)"
	exit 0
else
	echo "No adequate changeset for $PACKAGE (found: ${FOUND_LEVEL:-none}, required: $REQUIRED_LEVEL or higher)"
	echo "Run 'pnpm changeset' and select '$PACKAGE' with a '$REQUIRED_LEVEL' (or higher) bump."
	exit 1
fi
