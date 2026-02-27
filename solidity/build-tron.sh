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

OZ_CREATE2="dependencies/@openzeppelin-contracts-4.9.3/contracts/utils/Create2.sol"

# Collect all .sol files that use isContract (contracts + dependencies + OZ deps).
# In pnpm workspaces, OZ packages often live in node_modules/.pnpm/... instead of
# under node_modules/@openzeppelin symlinks, so include both layouts.
ISCONTRACT_DIRS="contracts/ dependencies/"
if [ -d "node_modules/@openzeppelin/" ]; then
  ISCONTRACT_DIRS="$ISCONTRACT_DIRS node_modules/@openzeppelin/"
fi
for pnpm_dir in node_modules/.pnpm ../node_modules/.pnpm; do
  for d in $(find "$pnpm_dir" -maxdepth 1 -type d -name '@openzeppelin+*' 2>/dev/null); do
    if [ -d "$d/node_modules/@openzeppelin/" ]; then
      ISCONTRACT_DIRS="$ISCONTRACT_DIRS $d/node_modules/@openzeppelin/"
    fi
  done
done
# shellcheck disable=SC2086
ISCONTRACT_FILES=$(grep -Rrl 'isContract(' $ISCONTRACT_DIRS --include='*.sol' || true)

# Backup all files we'll modify
backup_files() {
  cp "$OZ_CREATE2" "$OZ_CREATE2.bak"
  for f in $ISCONTRACT_FILES; do
    cp "$f" "$f.bak"
  done
}

# Restore all files from backups
restore_files() {
  if [ -e "$OZ_CREATE2.bak" ]; then
    mv "$OZ_CREATE2.bak" "$OZ_CREATE2"
  fi
  for f in $ISCONTRACT_FILES; do
    if [ -e "$f.bak" ]; then
      mv "$f.bak" "$f"
    fi
  done
}

# Ensure restoration even on failure
trap restore_files EXIT

backup_files

# Patch Create2.sol with Tron-specific version (0x41 prefix)
cp overrides/tron/Create2.sol "$OZ_CREATE2"

# Patch isContract() calls → address.code.length > 0
# Uses Node script to handle nested parentheses correctly
# shellcheck disable=SC2086
node patch-isContract.mjs $ISCONTRACT_FILES

# Compile with tron-solc
NODE_OPTIONS='--import tsx/esm' hardhat --config tron-hardhat.config.cts compile

# Compile generated tron typechain TS into JS for package consumers.
pnpm exec tsc --project tsconfig.tron-typechain.json

# trap will restore files
trap - EXIT
restore_files
