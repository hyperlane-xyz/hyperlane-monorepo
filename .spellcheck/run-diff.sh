#!/usr/bin/env bash
# Run typos only on files changed vs the base branch (default: main).
# Usage: bash .spellcheck/run-diff.sh [base-branch]
set -euo pipefail

BASE="${1:-main}"
MERGE_BASE="$(git merge-base "$BASE" HEAD)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Collect changed files (null-delimited for space-safe handling),
# deduplicate, filter to files that exist on disk.
{
  git diff -z --name-only --diff-filter=d "$MERGE_BASE" HEAD
  git diff -z --name-only --diff-filter=d HEAD
} | sort -zu | while IFS= read -r -d '' f; do
  [ -f "$f" ] && printf '%s\0' "$f"
done | {
  # Read into array; if empty, exit early.
  FILES=()
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done

  if [ ${#FILES[@]} -eq 0 ]; then
    echo "No changed files vs $BASE."
    exit 0
  fi

  typos --config "$SCRIPT_DIR/typos.toml" --force-exclude "${FILES[@]}"
}
