set -e # exit on error

# generates lcov.info
forge coverage --report lcov

# generates coverage/lcov.info
yarn hardhat coverage

# Foundry uses paths relative to hyperlane-monorepo/solidity
# whereas Hardhat uses absolute paths (locally) or paths
# relative to hyperlane-monorepo (ci).
# We convert Hardhat paths to Foundry paths so coverage artifacts
# can be merged.
sed -i -e 's/\/.*solidity.//g' coverage/lcov.info

# Merge lcov files
lcov --add-tracefile coverage/lcov.info --add-tracefile lcov.info --output-file merged-lcov.info

# Filter out node_modules, test, and mock files
lcov --remove merged-lcov.info --output-file filtered-lcov.info "*node_modules*" "*test*" "*mock*"

# Generate summary
lcov --summary filtered-lcov.info

# Open more granular breakdown in browser
if [ "$CI" != "true" ]
then
    genhtml -o coverage filtered-lcov.info && open coverage/index.html
fi
