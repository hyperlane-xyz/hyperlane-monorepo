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

# Compile generated tron typechain TS into JS when present.
# Newer viem-based flows may not emit typechain sources.
TYPECHAIN_TS_COUNT=$(find ./artifacts-tron/typechain -type f -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
if [ "$TYPECHAIN_TS_COUNT" -gt 0 ]; then
  pnpm exec tsc --project tsconfig.tron-typechain.json
else
  # Keep package export target valid without requiring generated sources.
  mkdir -p ./dist/tron/typechain
  cat > ./dist/tron/typechain/index.js <<'EOF'
export {};
EOF
  cat > ./dist/tron/typechain/index.d.ts <<'EOF'
export {};
EOF
fi

# trap will restore files
trap - EXIT
restore_files
