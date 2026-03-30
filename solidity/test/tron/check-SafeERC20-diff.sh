#!/bin/bash
# Verifies that the Tron SafeERC20 override only differs from upstream OZ
# within the ===== BEGIN/END TRON OVERRIDE ===== markers.
# The override is in .prettierignore to preserve upstream formatting.
set -e
cd "$(dirname "$0")/../.."

UPSTREAM="dependencies/@openzeppelin-contracts-4.9.3/contracts/token/ERC20/utils/SafeERC20.sol"
OVERRIDE="overrides/tron/SafeERC20.sol"

BEGIN=$(grep -n 'BEGIN TRON OVERRIDE' "$OVERRIDE" | cut -d: -f1)
END=$(grep -n 'END TRON OVERRIDE' "$OVERRIDE" | cut -d: -f1)
OVERRIDE_LEN=$(wc -l < "$OVERRIDE" | tr -d ' ')
UPSTREAM_LEN=$(wc -l < "$UPSTREAM" | tr -d ' ')
TAIL_LEN=$((OVERRIDE_LEN - END))

# Lines before BEGIN must match upstream head
# Lines after END must match upstream tail
DIFF=$(diff <(head -n $((BEGIN - 1)) "$OVERRIDE"; tail -n "$TAIL_LEN" "$OVERRIDE") \
            <(head -n $((BEGIN - 1)) "$UPSTREAM"; tail -n "$TAIL_LEN" "$UPSTREAM") || true)

if [ -z "$DIFF" ]; then
  echo "OK: Override matches upstream outside of TRON OVERRIDE markers"
else
  echo "FAIL: Override differs from upstream outside of markers:"
  echo "$DIFF"
  exit 1
fi
