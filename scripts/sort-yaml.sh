#!/usr/bin/env bash
# Sort YAML files: keys alphabetically, and specific arrays by designated fields.
# Replaces the former eslint-based sort-yaml-arrays rule.
#
# Usage:
#   ./scripts/sort-yaml.sh [--check] [files...]
#
# If no files are given, defaults to typescript/infra/**/*.yaml (excluding helm templates).
# --check  exits non-zero if any file would change (CI mode).

set -euo pipefail
cd "$(dirname "$0")/.."

CHECK=false
FILES=()

for arg in "$@"; do
  case "$arg" in
    --check) CHECK=true ;;
    *) FILES+=("$arg") ;;
  esac
done

# Default file set: infra YAML configs (skip helm templates which use Go templating)
if [ ${#FILES[@]} -eq 0 ]; then
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find typescript/infra -name '*.yaml' -o -name '*.yml' | \
    grep -v '/helm/' | \
    grep -v '/node_modules/' | \
    grep -v '/dist/' | \
    grep -v '/rebalancer/' | \
    tr '\n' '\0')
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No YAML files found."
  exit 0
fi

args=(./scripts/sort-yaml.ts)
[ "$CHECK" = true ] && args+=(--check)
args+=("${FILES[@]}")

pnpm exec tsx "${args[@]}"
