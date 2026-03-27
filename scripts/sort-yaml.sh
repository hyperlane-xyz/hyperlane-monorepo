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

# Check yq is available
if ! command -v yq &>/dev/null; then
  echo "Error: yq is required but not installed. Install via: brew install yq" >&2
  exit 1
fi

FAILED=false

for file in "${FILES[@]}"; do
  [ -f "$file" ] || continue

  # Build a yq expression that:
  # 1. Sorts .tokens by .chainName
  # 2. Sorts .tokens[].connections by .token
  # 3. Sorts *.interchainSecurityModule.modules by .type
  # 4. Sorts *.interchainSecurityModule.modules[].domains.*.modules by .type
  # 5. Sorts all keys recursively
  YQ_EXPR='
    # Sort tokens array by chainName
    (select(.tokens) | .tokens) |= sort_by(.chainName) |

    # Sort each token connections array by token field
    (select(.tokens) | .tokens[].connections) |= sort_by(.token) |

    # Sort ISM modules by type (top-level wildcard keys)
    (.[] | select(has("interchainSecurityModule")) | .interchainSecurityModule.modules) |= sort_by(.type) |

    # Sort nested ISM domain modules by type
    (.[] | select(has("interchainSecurityModule")) | .interchainSecurityModule.modules[]? | select(has("domains")) | .domains.[]?.modules) |= sort_by(.type) |

    # Sort all keys recursively
    sort_keys(..)
  '

  if [ "$CHECK" = true ]; then
    # Compare current file with sorted version
    SORTED=$(yq eval "$YQ_EXPR" "$file" 2>/dev/null || cat "$file")
    if ! diff -q <(cat "$file") <(echo "$SORTED") &>/dev/null; then
      echo "UNSORTED: $file"
      FAILED=true
    fi
  else
    # Sort in-place
    yq eval -i "$YQ_EXPR" "$file" 2>/dev/null || true
    echo "Sorted: $file"
  fi
done

if [ "$FAILED" = true ]; then
  echo ""
  echo "Some YAML files are not sorted. Run: ./scripts/sort-yaml.sh"
  exit 1
fi
