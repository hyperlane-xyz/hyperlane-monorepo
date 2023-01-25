yarn hardhat coverage && forge coverage --report lcov && \
# Foundry uses paths relative to hyperlane-monorepo/solidity
# whereas Hardhat uses absolute paths (locally) or paths
# relative to hyperlane-monorepo (ci).
# We convert Hardhat paths to Foundry paths so coverage artifacts
# can be merged.
sed -i -e 's/\/.*solidity.//g' coverage/lcov.info && \
# Merge the two 
find . -name lcov.info -exec echo -a {} \; | xargs lcov -o lcov.info && \
# Clean up output
rm -rf coverage && \
# Remove files we don't care about covering
lcov --remove lcov.info -o lcov.info 'contracts/test/**' 'contracts/mock/**' '**/node_modules/**' 'test/*' && \
# Print output
lcov --list lcov.info
