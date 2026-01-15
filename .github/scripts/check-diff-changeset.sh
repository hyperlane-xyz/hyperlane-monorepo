#!/bin/bash
# Analyzes a diff between two directories and validates changeset requirements
# Usage: check-diff-changeset.sh <analysis-type> <base-dir> <head-dir>
# analysis-type: bytecode | storage
#
# For bytecode: any change requires patch+
# For storage: additions require minor+, removals require major

set -euo pipefail

ANALYSIS_TYPE=${1:-}
BASE_DIR=${2:-}
HEAD_DIR=${3:-}

if [ -z "$ANALYSIS_TYPE" ] || [ -z "$BASE_DIR" ] || [ -z "$HEAD_DIR" ]; then
  echo "Usage: check-diff-changeset.sh <bytecode|storage> <base-dir> <head-dir>"
  exit 1
fi

# Verify directories exist
if [ ! -d "$BASE_DIR" ]; then
  echo "ERROR: Base directory does not exist: $BASE_DIR"
  exit 1
fi
if [ ! -d "$HEAD_DIR" ]; then
  echo "ERROR: Head directory does not exist: $HEAD_DIR"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Generate diff
DIFF_OUTPUT=$(diff --unified --recursive "$BASE_DIR" "$HEAD_DIR" || true)

if [ -z "$DIFF_OUTPUT" ]; then
  echo "No $ANALYSIS_TYPE changes detected."
  exit 0
fi

echo "Detected $ANALYSIS_TYPE changes:"
echo "$DIFF_OUTPUT"
echo ""

# Classify changes
HAS_REMOVALS=false
HAS_ADDITIONS=false

# Check for removed lines in diff (lines starting with '-' but not '---')
if echo "$DIFF_OUTPUT" | grep -E '^-[^-]' >/dev/null; then
  HAS_REMOVALS=true
fi
# Check for added lines in diff (lines starting with '+' but not '+++')
if echo "$DIFF_OUTPUT" | grep -E '^\+[^+]' >/dev/null; then
  HAS_ADDITIONS=true
fi
# Check for files only in base (removed files) - "Only in <base-dir>"
if echo "$DIFF_OUTPUT" | grep -E "^Only in ${BASE_DIR}" >/dev/null; then
  HAS_REMOVALS=true
fi
# Check for files only in head (added files) - "Only in <head-dir>"
if echo "$DIFF_OUTPUT" | grep -E "^Only in ${HEAD_DIR}" >/dev/null; then
  HAS_ADDITIONS=true
fi

# Determine required level based on analysis type and change classification
case "$ANALYSIS_TYPE" in
bytecode)
  # Any bytecode change requires patch
  REQUIRED_LEVEL="patch"
  CHANGE_DESC="Bytecode changes"
  ;;
storage)
  if [ "$HAS_REMOVALS" = true ]; then
    REQUIRED_LEVEL="major"
    CHANGE_DESC="Storage layout removals (breaking change)"
  elif [ "$HAS_ADDITIONS" = true ]; then
    REQUIRED_LEVEL="minor"
    CHANGE_DESC="Storage layout additions"
  else
    echo "No significant storage changes detected."
    exit 0
  fi
  ;;
*)
  echo "Unknown analysis type: $ANALYSIS_TYPE"
  exit 1
  ;;
esac

echo "$CHANGE_DESC detected."
echo ""

# Check for adequate changeset
if "$SCRIPT_DIR/check-solidity-changeset.sh" "$REQUIRED_LEVEL"; then
  echo ""
  echo "$CHANGE_DESC are permitted with the existing changeset."
  exit 0
else
  echo ""
  echo "ERROR: $CHANGE_DESC require a changeset for @hyperlane-xyz/core with at least a '$REQUIRED_LEVEL' bump."
  exit 1
fi
