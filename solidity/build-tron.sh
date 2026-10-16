#!/bin/sh
set -e
cd "$(dirname "$0")"

# Turbo installs dependencies before this task. Standalone invocations also
# need them; avoid writing dependencies while the EVM compiler reads them.
if [ ! -d dependencies/@openzeppelin-contracts-4.9.3 ]; then
  forge soldeer install --quiet
fi
pnpm version:update

# Apply Tron patches in memory. Compile core and Warp entrypoints separately
# because the complete repository exceeds tron-solc's WASM input limit. Both
# passes retain their outputs in the same artifact tree.
TRON_BUILD_TARGET=core pnpm hardhat-tron compile --force --no-typechain
TRON_BUILD_TARGET=warp pnpm hardhat-tron compile --force --no-typechain

# Rebuild bindings from surviving artifacts so deleted/renamed contracts cannot
# leave stale exports behind.
rm -rf ./artifacts-tron/typechain ./dist/tron/typechain
pnpm hardhat-tron typechain
pnpm exec tsc --project tsconfig.tron-typechain.json
node fix-typechain-ethers.mjs ./dist/tron/typechain/factories
