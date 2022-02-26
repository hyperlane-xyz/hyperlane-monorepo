# script for auto-formatting supported files
# Run from root (./scripts/format.sh)

set -e

# create symlinks
npm --prefix ./typescript/typechain link
npm --prefix ./typescript/abacus-sdk link
npm --prefix ./typescript/abacus-deploy link

# link abacus-sdk
npm --prefix ./typescript/abacus-sdk link @abacus-network/ts-interface

# link abacus-deploy
npm --prefix ./typescript/abacus-deploy link @abacus-network/ts-interface
npm --prefix ./typescript/abacus-deploy link @abacus-network/sdk

# link abacus-tests
npm --prefix ./typescript/abacus-tests link @abacus-network/ts-interface
npm --prefix ./typescript/abacus-tests link @abacus-network/sdk
npm --prefix ./typescript/abacus-tests link @abacus-network/abacus-deploy
