#!/bin/bash
# Verifies that the Tron SafeERC20 override only differs from upstream OZ
# between the ===== BEGIN/END TRON OVERRIDE ===== markers (plus imports and
# header comment).
#
# Usage: bash test/tron/check-SafeERC20-diff.sh
set -e
cd "$(dirname "$0")/../.."

UPSTREAM="dependencies/@openzeppelin-contracts-4.9.3/contracts/token/ERC20/utils/SafeERC20.sol"
OVERRIDE="overrides/tron/SafeERC20.sol"

if [ ! -f "$UPSTREAM" ]; then
  echo "Upstream not found at $UPSTREAM — run 'forge soldeer install' first"
  exit 1
fi

echo "=== Full diff (for review) ==="
diff -u "$UPSTREAM" "$OVERRIDE" || true
echo ""

FAIL=0

# 1. Check markers exist in override
for marker in 'BEGIN TRON OVERRIDE' 'END TRON OVERRIDE'; do
  if ! grep -q "$marker" "$OVERRIDE"; then
    echo "FAIL: $marker marker not found"; FAIL=1
  fi
done

# 2. Compare both files after stripping only the expected differences:
#    - Override: everything between BEGIN/END markers, import lines, header comment
#    - Upstream: import lines and the original safeTransfer function + its natspec
#    Then normalize whitespace (prettier reformats the override).

OVERRIDE_NORM=$(
  sed '/===== BEGIN TRON OVERRIDE =====/,/===== END TRON OVERRIDE =====/d' "$OVERRIDE" \
    | sed '/^import /d; /^\/\/ Modified for Tron/d' \
    | tr -d '[:space:]'
)

# For upstream, strip imports and the safeTransfer region.
# We identify it as: the natspec + function between 'using Address' and 'safeTransferFrom'.
# Use awk to skip from the first /** after 'using Address' until the blank line before
# the next /** (safeTransferFrom's natspec).
UPSTREAM_NORM=$(
  sed '/^import /d' "$UPSTREAM" \
    | awk '
      # After seeing "using Address", start looking for safeTransfer natspec
      /using Address/ { seen_using=1 }
      # First /** after using Address starts the safeTransfer block
      seen_using && /\/\*\*/ && !in_block { in_block=1 }
      # safeTransfer closing brace ends the block
      in_block && /^    \}/ { in_block=0; seen_using=0; next }
      in_block { next }
      { print }
    ' \
    | tr -d '[:space:]'
)

if [ "$UPSTREAM_NORM" = "$OVERRIDE_NORM" ]; then
  echo "OK: Override matches upstream outside of TRON OVERRIDE section and imports"
else
  echo "FAIL: Override differs from upstream outside of marked section!"
  diff <(echo "$UPSTREAM_NORM" | fold -w 80) <(echo "$OVERRIDE_NORM" | fold -w 80) || true
  FAIL=1
fi

if [ "$FAIL" -eq 1 ]; then
  exit 1
fi
