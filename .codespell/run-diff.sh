#!/usr/bin/env bash
# Run codespell only on files changed vs the base branch (default: main).
# Usage: bash .codespell/run-diff.sh [base-branch]
set -euo pipefail
source "$(dirname "$0")/ensure-venv.sh"
BASE="${1:-main}"

MERGE_BASE="$(git merge-base "$BASE" HEAD)"

if ! git diff --name-only --diff-filter=d "$MERGE_BASE" HEAD | grep -q .; then
  echo "No changed files vs $BASE."
  exit 0
fi

git diff --name-only -z --diff-filter=d "$MERGE_BASE" HEAD | xargs -0 "$CODESPELL" --config="$CODESPELL_CONFIG"
