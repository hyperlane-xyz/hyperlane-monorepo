LICENSE="// SPDX-License-Identifier: MIT OR Apache-2.0"

rm -rf flattened
mkdir -p flattened

# flatten contracts
yarn hardhat flatten > flattened/flattened.sol

# Copy HelloWorld.sol without imports and append to flattened/flattened.sol
cat ../typescript/helloworld/contracts/HelloWorld.sol | grep -vE "import.*;" >> flattened/flattened.sol

# remove duplicate licenses
grep -vE "// SPDX.*" flattened/flattened.sol > flattened/delicensed.sol

# add license
echo "$LICENSE" | cat - flattened/delicensed.sol > flattened/licensed.sol

# Path to the Solidity file
SOLIDITY_FILE="flattened/licensed.sol"
# Temp file to store intermediate results
TEMP_FILE="tmp-licensed.sol"
# Remove the comment and the ICrossDomainMessenger interface that follows it
awk "/^\/\/ File @openzeppelin\/.*\/ICrossDomainMessenger\.sol/,/^}/ { if (/^}/) print \"\"; next } 1" $SOLIDITY_FILE > $TEMP_FILE && mv $TEMP_FILE $SOLIDITY_FILE
# Replace "Optimism_Bridge" with "ICrossDomainMessenger"
sed -i '' 's/Optimism_Bridge/ICrossDomainMessenger/g' $SOLIDITY_FILE

# compile
solc flattened/licensed.sol

if [ $? -ne 0 ]; then
    echo "Remove @openzeppelin/../ICrossDomainMessenger and replace Optimism_Bridge with ICrossDomainMessenger"
    echo "Then try compiling again with solc flattened/licensed.sol"
    exit 1
fi
