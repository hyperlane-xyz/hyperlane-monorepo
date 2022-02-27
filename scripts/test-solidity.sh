# script for running solidity tests locally
# Run from root (./scripts/test-solidity.sh)

set -e

# compile contracts
npm run build

# copy artifacts
cp -R ./solidity/abacus-xapps/artifacts ./typescript/abacus-tests
cp -R ./solidity/abacus-core/artifacts ./typescript/abacus-tests

# copy cache
cp -R ./solidity/abacus-xapps/cache ./typescript/abacus-tests
cp -R ./solidity/abacus-core/cache ./typescript/abacus-tests

# run tests
npm --prefix ./typescript/abacus-tests run testNoCompile
