yarn hardhat coverage && forge coverage --report lcov
# Hardhat uses absolute paths, whereas foundry uses relative paths
# We convert hardhat's output to relative paths so they can be merged
sed -i '' 's/\/.*hyperlane-monorepo.*solidity.//g' coverage/lcov.info 
# Merge the two 
find . -name lcov.info -exec echo -a {} \; | xargs lcov -o lcov.info
# Clean up output
rm -rf coverage
# Remove files we don't care about covering
lcov --remove lcov.info -o lcov.info 'contracts/test/**' 'contracts/mock/**' '**/node_modules/**' 'test/*'
# Print output
lcov --list lcov.info
