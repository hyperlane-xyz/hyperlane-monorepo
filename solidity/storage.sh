#!/bin/bash

CONTRACTS=(
Mailbox \
MailboxClient Router GasRouter \
InterchainGasPaymaster StorageGasOracle \
MerkleTreeHook \
HypERC20 HypERC20Collateral \
HypERC721 HypERC721Collateral \
HypNative HypNativeScaled
)

for contract in "${CONTRACTS[@]}";
do
    forge inspect "$contract" storage --pretty > "storage/$contract.md"
done
