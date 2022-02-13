# script for running solidity tests locally
# Run from root (./scripts/test-solidity.sh)

set -e

# compile contracts
cd ./solidity/abacus-core
npm run compile
cd ../abacus-xapps
npm run compile

cd ../../
# copy artifacts
cp -R ./solidity/abacus-xapps/artifacts ./typescript/abacus-tests
cp -R ./solidity/abacus-core/artifacts ./typescript/abacus-tests

# copy cache
cp -R ./solidity/abacus-xapps/cache ./typescript/abacus-tests
cp -R ./solidity/abacus-core/cache ./typescript/abacus-tests

# run tests
cd ./typescript/abacus-tests
npm i
npm run testNoCompile
cd ../..
