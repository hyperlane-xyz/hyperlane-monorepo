#!/bin/bash
# Checks if @hyperlane-xyz/core has a changeset at or above the required level,
# OR if the version in solidity/package.json was manually bumped by an adequate amount.
#
# Usage: check-solidity-changeset.sh <required-level> <base-ref>
# Levels: patch < minor < major
# Exit 0 if adequate changeset or version bump exists, exit 1 otherwise
#
# Note: This parses .changeset/*.md files directly instead of using the changeset CLI
# because the CLI requires git history (merge-base) which fails in shallow clones.
# See: https://github.com/changesets/changesets/issues/700
#
# Only changesets added since base-ref are checked, ensuring we validate
# changesets introduced by the current PR, not pre-existing ones.
#
# Manual version bumps (e.g., via `pnpm changeset version`) are also accepted
# if the bump magnitude is adequate for the detected changes.

set -euo pipefail

REQUIRED_LEVEL=${1:-}
BASE_REF=${2:-}
PACKAGE="@hyperlane-xyz/core"

if [ -z "$REQUIRED_LEVEL" ] || [ -z "$BASE_REF" ]; then
	echo "Usage: check-solidity-changeset.sh <patch|minor|major> <base-ref>"
	exit 1
fi

# Map levels to numbers for comparison
level_to_num() {
	case "$1" in
	patch) echo 1 ;; minor) echo 2 ;; major) echo 3 ;; *) echo 0 ;;
	esac
}

# Check for manual version bump in solidity/package.json
OLD_VERSION=$(git show "$BASE_REF":solidity/package.json | jq -r '.version')
NEW_VERSION=$(jq -r '.version' solidity/package.json)

if [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
	OLD_MAJOR=$(echo "$OLD_VERSION" | cut -d. -f1)
	NEW_MAJOR=$(echo "$NEW_VERSION" | cut -d. -f1)
	OLD_MINOR=$(echo "$OLD_VERSION" | cut -d. -f2)
	NEW_MINOR=$(echo "$NEW_VERSION" | cut -d. -f2)
	OLD_PATCH=$(echo "$OLD_VERSION" | cut -d. -f3)
	NEW_PATCH=$(echo "$NEW_VERSION" | cut -d. -f3)

	BUMP_LEVEL=""
	if [ "$NEW_MAJOR" -gt "$OLD_MAJOR" ]; then
		BUMP_LEVEL="major"
	elif [ "$NEW_MAJOR" -eq "$OLD_MAJOR" ] && [ "$NEW_MINOR" -gt "$OLD_MINOR" ]; then
		BUMP_LEVEL="minor"
	elif [ "$NEW_MAJOR" -eq "$OLD_MAJOR" ] && [ "$NEW_MINOR" -eq "$OLD_MINOR" ] && [ "$NEW_PATCH" -gt "$OLD_PATCH" ]; then
		BUMP_LEVEL="patch"
	fi

	if [ -n "$BUMP_LEVEL" ] && [ "$(level_to_num "$BUMP_LEVEL")" -ge "$(level_to_num "$REQUIRED_LEVEL")" ]; then
		echo "Found manual version bump: $OLD_VERSION -> $NEW_VERSION ($BUMP_LEVEL, required: $REQUIRED_LEVEL)"
		exit 0
	fi
fi

# Get only newly added changeset files compared to base, then cat their contents
NEW_CHANGESETS=$(git diff --name-only --diff-filter=A "$BASE_REF" -- '.changeset/*.md' 2>/dev/null || true)
if [ -z "$NEW_CHANGESETS" ]; then
	echo "No new changesets found in this PR."
	echo "Run 'pnpm changeset' and select '$PACKAGE' with a '$REQUIRED_LEVEL' (or higher) bump."
	exit 1
fi

# Read content of new changeset files
CHANGESET_CONTENT=$(echo "$NEW_CHANGESETS" | xargs cat 2>/dev/null || true)

# Search for the package and extract bump level
# Format in changeset files: '@hyperlane-xyz/core': minor
FOUND_LEVEL=""
if echo "$CHANGESET_CONTENT" | grep -q "$PACKAGE"; then
	# Found the package, extract the level (major > minor > patch)
	if echo "$CHANGESET_CONTENT" | grep "$PACKAGE" | grep -q "major"; then
		FOUND_LEVEL="major"
	elif echo "$CHANGESET_CONTENT" | grep "$PACKAGE" | grep -q "minor"; then
		FOUND_LEVEL="minor"
	elif echo "$CHANGESET_CONTENT" | grep "$PACKAGE" | grep -q "patch"; then
		FOUND_LEVEL="patch"
	fi
fi

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
