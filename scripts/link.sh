# script for auto-formatting supported files
# Run from root (./scripts/link.sh)
# NB: Using --prefix here causes npm to create and expect a "lib" directory
# at the prefix. Instead, we choose to use the global prefix so as not to
# create those directories.

set -e

# create symlinks
# NB: Using --prefix here would create a "lib" folder in the package
cd ./typescript/typechain && npm link && cd ../../
cd ./typescript/abacus-sdk && npm link && cd ../../
cd ./typescript/abacus-deploy && npm link && cd ../../

# link abacus-sdk
cd ./typescript/abacus-sdk
npm link @abacus-network/ts-interface
cd ../../

# link abacus-deploy
cd ./typescript/abacus-deploy
npm link @abacus-network/ts-interface @abacus-network/sdk
cd ../../

# link abacus-tests
cd ./typescript/abacus-tests
npm link @abacus-network/ts-interface @abacus-network/sdk @abacus-network/abacus-deploy
cd ../../
