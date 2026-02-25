#!/usr/bin/env bash
# Run codespell only on files changed vs the base branch (default: main).
# Usage: bash .codespell/run-diff.sh [base-branch]
set -euo pipefail
source "$(dirname "$0")/ensure-venv.sh"
BASE="${1:-main}"

MERGE_BASE="$(git merge-base "$BASE" HEAD)"
FILES="$(git diff --name-only --diff-filter=d "$MERGE_BASE" HEAD)"

if [ -z "$FILES" ]; then
  echo "No changed files vs $BASE."
  exit 0
fi

echo "$FILES" | xargs "$CODESPELL" --config="$CODESPELL_CONFIG"
