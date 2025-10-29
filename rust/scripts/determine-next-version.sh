#!/usr/bin/env bash
# Determine next version based on conventional commits
#
# Usage:
#   determine-next-version.sh CURRENT_VERSION [COMMIT_RANGE]
#
# Arguments:
#   CURRENT_VERSION - The current version (e.g., "1.4.0")
#   COMMIT_RANGE    - Optional git commit range (e.g., "v1.4.0..HEAD"). If omitted, uses latest tag..HEAD
#
# Returns:
#   Outputs two lines:
#     1. The next version (e.g., "1.5.0")
#     2. The bump type ("major", "minor", or "patch")
#
# Examples:
#   ./determine-next-version.sh "1.4.0"
#   ./determine-next-version.sh "1.4.0" "v1.4.0..HEAD"
#
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Error: CURRENT_VERSION is required" >&2
  echo "Usage: $0 CURRENT_VERSION [COMMIT_RANGE]" >&2
  exit 1
fi

CURRENT_VERSION="$1"
COMMIT_RANGE="${2:-}"

# Determine script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_MAIN_DIR="$SCRIPT_DIR/../main"

# If no commit range specified, use commits since latest tag
if [ -z "$COMMIT_RANGE" ]; then
  LATEST_TAG=$("$SCRIPT_DIR/get-latest-agents-tag.sh")

  if [ -z "$LATEST_TAG" ]; then
    # Get all commits in rust/main
    cd "$RUST_MAIN_DIR"
    COMMITS=$(git log --oneline --no-merges -- .)
  else
    cd "$RUST_MAIN_DIR"
    COMMITS=$(git log "${LATEST_TAG}..HEAD" --oneline --no-merges -- .)
  fi
else
  cd "$RUST_MAIN_DIR"
  COMMITS=$(git log "$COMMIT_RANGE" --oneline --no-merges -- .)
fi

# Parse current version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Analyze commits for conventional commit types
HAS_BREAKING=false
HAS_MINOR=false
HAS_PATCH=false

while IFS= read -r commit; do
  # Skip empty lines
  [ -z "$commit" ] && continue

  # Check for breaking changes via ! suffix
  if echo "$commit" | grep -qE "^[a-f0-9]+ [a-z]+(\(.+\))?!:"; then
    HAS_BREAKING=true
  # Check for minor changes (new features, refactors, perf improvements, chores)
  elif echo "$commit" | grep -qE "^[a-f0-9]+ (feat|refactor|perf|chore)(\(.+\))?:"; then
    HAS_MINOR=true
  # Check for patch changes (fixes, docs, tests, ci, style, build)
  elif echo "$commit" | grep -qE "^[a-f0-9]+ (fix|docs|test|ci|style|build)(\(.+\))?:"; then
    HAS_PATCH=true
  fi

  # Check commit body for BREAKING CHANGE
  COMMIT_HASH=$(echo "$commit" | cut -d' ' -f1)
  if git show -s --format=%B "$COMMIT_HASH" | grep -q "BREAKING CHANGE:"; then
    HAS_BREAKING=true
  fi
done <<< "$COMMITS"

# Determine version bump
if [ "$HAS_BREAKING" = true ]; then
  MAJOR=$((MAJOR + 1))
  MINOR=0
  PATCH=0
  BUMP_TYPE="major"
elif [ "$HAS_MINOR" = true ]; then
  MINOR=$((MINOR + 1))
  PATCH=0
  BUMP_TYPE="minor"
elif [ "$HAS_PATCH" = true ]; then
  PATCH=$((PATCH + 1))
  BUMP_TYPE="patch"
else
  # Default to patch for any other changes
  PATCH=$((PATCH + 1))
  BUMP_TYPE="patch"
fi

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

# Output results (two lines)
echo "$NEW_VERSION"
echo "$BUMP_TYPE"
