# script for running solidity tests locally
# Run from root (./scripts/test-solidity.sh)

set -e

# compile contracts
cd ./solidity/optics-core
npm run compile
cd ../optics-xapps
npm run compile

cd ../../
# copy artifacts
cp -R ./solidity/optics-xapps/artifacts ./typescript/optics-tests
cp -R ./solidity/optics-core/artifacts ./typescript/optics-tests

# copy cache
cp -R ./solidity/optics-xapps/cache ./typescript/optics-tests
cp -R ./solidity/optics-core/cache ./typescript/optics-tests

# run tests
cd ./typescript/optics-tests
npm i
npm run testNoCompile
cd ../..
