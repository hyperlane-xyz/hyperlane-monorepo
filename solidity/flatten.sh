LICENSE="// SPDX-License-Identifier: MIT OR Apache-2.0"

rm -rf flattened
mkdir -p flattened

# flatten contracts
yarn hardhat flatten > flattened/flattened.sol

# remove duplicate licenses
grep -vE "// SPDX.*" flattened/flattened.sol > flattened/delicensed.sol

# add license
echo "$LICENSE" | cat - flattened/delicensed.sol > flattened/licensed.sol

# compile
solc flattened/licensed.sol

# TODO: automate this?
if [ $? -ne 0 ]; then
    echo "Remove @openzeppelin/../ICrossDomainMessenger and replace Optimism_Bridge with ICrossDomainMessenger"
    echo "Then try compiling again with solc flattened/licensed.sol"
    exit 1
fi
