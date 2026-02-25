#!/bin/sh
set -e
cd "$(dirname "$0")"

# Ensure soldeer dependencies are installed before patching files.
# The regular @hyperlane-xyz/core build also runs soldeer install, and if it
# runs concurrently with our file patches below, soldeer's git checkout fails
# on the dirty working tree. Running it first avoids the race condition.
forge soldeer install --quiet

OZ_CREATE2="dependencies/@openzeppelin-contracts-4.9.3/contracts/utils/Create2.sol"

# Collect all .sol files that use isContract (contracts + dependencies)
ISCONTRACT_FILES=$(grep -rl '\.isContract\b' contracts/ dependencies/ --include='*.sol' || true)

# Backup all files we'll modify
backup_files() {
  cp "$OZ_CREATE2" "$OZ_CREATE2.bak"
  for f in $ISCONTRACT_FILES; do
    cp "$f" "$f.bak"
  done
}

# Restore all files from backups
restore_files() {
  mv "$OZ_CREATE2.bak" "$OZ_CREATE2"
  for f in $ISCONTRACT_FILES; do
    mv "$f.bak" "$f"
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

# trap will restore files
trap - EXIT
restore_files
