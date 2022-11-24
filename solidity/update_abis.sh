#!/bin/sh 

# Must be ran from the `solidity` directory

copy() {
    # Optionally allow path to be passed in, and extract the contract name
    # as the string following the last instance of `/`
    CONTRACT_NAME="${1##*/}"
    jq .abi < artifacts/contracts/"$1".sol/"$CONTRACT_NAME".json > ../rust/chains/abacus-ethereum/abis/"$CONTRACT_NAME".abi.json
}

copy Mailbox && copy isms/MultisigIsm && copy InterchainGasPaymaster
