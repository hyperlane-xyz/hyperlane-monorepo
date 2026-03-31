#!/bin/sh
set -e
cd "$(dirname "$0")"

# Ensure deterministic tron outputs for caching and downstream package imports.
rm -rf ./cache-tron ./artifacts-tron ./dist/tron/typechain

# Soldeer dependencies are already installed by the turbo deps:soldeer task
# (build:tron depends on build, which depends on deps:soldeer).
# This call is a safety net for standalone invocations; allow it to fail
# gracefully since deps may already be present (e.g. forge v1.1.0 soldeer bug).
forge soldeer install --quiet || echo "Warning: soldeer install failed, assuming dependencies are already present"

# Files to patch for Tron compatibility (newline-separated, dest:src)
PATCH_FILES="dependencies/@openzeppelin-contracts-4.9.3/contracts/utils/Create2.sol:overrides/tron/Create2.sol
dependencies/@openzeppelin-contracts-4.9.3/contracts/token/ERC20/utils/SafeERC20.sol:overrides/tron/SafeERC20.sol"

# Iterate PATCH_FILES and run a command on each entry.
# Usage: for_each_patch cmd  →  cmd is called with each "dest:src" line as $1
for_each_patch() {
  _saved_ifs="$IFS"; IFS="
"
  for _entry in $PATCH_FILES; do
    "$@" "$_entry"
  done
  IFS="$_saved_ifs"
}

# Collect all .sol files that use isContract (contracts + dependencies),
# excluding files already handled by PATCH_FILES to avoid double-backup.
PATCH_DESTS=""
_collect_dest() { PATCH_DESTS="$PATCH_DESTS ${1%%:*}"; }
for_each_patch _collect_dest

ISCONTRACT_FILES=""
for f in $(grep -rl '\.isContract\b' contracts/ dependencies/ --include='*.sol' || true); do
  case "$PATCH_DESTS" in
    *"$f"*) ;;  # skip files already in PATCH_FILES
    *) ISCONTRACT_FILES="$ISCONTRACT_FILES $f" ;;
  esac
done

# Backup / restore helpers
_backup_patch()  { cp "${1%%:*}" "${1%%:*}.bak"; }
_restore_patch() { mv "${1%%:*}.bak" "${1%%:*}"; }
_apply_patch()   { cp "${1##*:}" "${1%%:*}"; }

backup_files() {
  for_each_patch _backup_patch
  for f in $ISCONTRACT_FILES; do cp "$f" "$f.bak"; done
}

restore_files() {
  for_each_patch _restore_patch
  for f in $ISCONTRACT_FILES; do mv "$f.bak" "$f"; done
}

# Ensure restoration even on failure
trap restore_files EXIT

backup_files

# Apply Tron-specific patches (Create2.sol, SafeERC20.sol)
for_each_patch _apply_patch

# Patch isContract() calls → address.code.length > 0
# Uses Node script to handle nested parentheses correctly
# shellcheck disable=SC2086
node patch-isContract.mjs $ISCONTRACT_FILES

# Compile with tron-solc
NODE_OPTIONS='--import tsx/esm' hardhat --config tron-hardhat.config.cts compile

# Compile generated tron typechain TS into JS for package consumers.
pnpm exec tsc --project tsconfig.tron-typechain.json

# Fix ethers v5/v6 compat: replace `import { utils } from "ethers"` with
# direct `Interface` import from `@ethersproject/abi` to avoid webpack
# resolution failures in downstream apps using barrel optimization.
node fix-typechain-ethers.mjs ./dist/tron/typechain/factories

# trap will restore files
trap - EXIT
restore_files
