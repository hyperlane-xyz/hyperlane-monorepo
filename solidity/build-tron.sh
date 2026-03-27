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

# Files to patch for Tron compatibility
PATCH_FILES=(
  # Patch Create2.sol with Tron-specific version (0x41 prefix)
  "dependencies/@openzeppelin-contracts-4.9.3/contracts/utils/Create2.sol:overrides/tron/Create2.sol"
  # Patch SafeERC20.sol with Tron-specific safeTransfer overwrites
  "dependencies/@openzeppelin-contracts-4.9.3/contracts/token/ERC20/utils/SafeERC20.sol:overrides/tron/SafeERC20.sol"
)

# Collect all .sol files that use isContract (contracts + dependencies),
# excluding files already handled by PATCH_FILES to avoid double-backup.
PATCH_DESTS=""
for patch in "${PATCH_FILES[@]}"; do
  PATCH_DESTS="$PATCH_DESTS ${patch%%:*}"
done
ISCONTRACT_FILES=""
for f in $(grep -rl '\.isContract\b' contracts/ dependencies/ --include='*.sol' || true); do
  case "$PATCH_DESTS" in
    *"$f"*) ;;  # skip files already in PATCH_FILES
    *) ISCONTRACT_FILES="$ISCONTRACT_FILES $f" ;;
  esac
done

# Backup all files we'll modify
backup_files() {
  for patch in "${PATCH_FILES[@]}"; do
    dest="${patch%%:*}"
    cp "$dest" "$dest.bak"
  done
  for f in $ISCONTRACT_FILES; do
    cp "$f" "$f.bak"
  done
}

# Restore all files from backups
restore_files() {
  for patch in "${PATCH_FILES[@]}"; do
    dest="${patch%%:*}"
    mv "$dest.bak" "$dest"
  done
  for f in $ISCONTRACT_FILES; do
    mv "$f.bak" "$f"
  done
}

# Ensure restoration even on failure
trap restore_files EXIT

backup_files

# Apply Tron-specific patches
for patch in "${PATCH_FILES[@]}"; do
  dest="${patch%%:*}"
  src="${patch##*:}"
  cp "$src" "$dest"
done

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
