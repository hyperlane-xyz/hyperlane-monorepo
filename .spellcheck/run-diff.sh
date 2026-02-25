#!/usr/bin/env bash
# Run typos only on files changed vs the base branch (default: main).
# Usage: bash .spellcheck/run-diff.sh [base-branch]
set -euo pipefail

BASE="${1:-main}"
MERGE_BASE="$(git merge-base "$BASE" HEAD)"
# List changed files (excluding deleted) between merge-base and HEAD,
# then also include any uncommitted changes in the working tree.
COMMITTED="$(git diff --name-only --diff-filter=d "$MERGE_BASE" HEAD)"
UNCOMMITTED="$(git diff --name-only --diff-filter=d HEAD)"
FILES="$(printf '%s\n%s' "$COMMITTED" "$UNCOMMITTED" | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done)"

if [ -z "$FILES" ]; then
  echo "No changed files vs $BASE."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "$FILES" | xargs typos --config "$SCRIPT_DIR/typos.toml"
