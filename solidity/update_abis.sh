#!/bin/sh 

# Must be ran from the `solidity` directory

copy() {
    # Optionally allow path to be passed in, and extract the contract name
    # as the string following the last instance of `/`
    CONTRACT_NAME="${1##*/}"
    jq .abi < artifacts/contracts/"$1".sol/"$CONTRACT_NAME".json > ../rust/chains/hyperlane-ethereum/abis/"$CONTRACT_NAME".abi.json
}

copy interfaces/IMailbox && copy interfaces/IInterchainGasPaymaster && copy interfaces/isms/IMultisigIsm && copy interfaces/IValidatorAnnounce && copy interfaces/IInterchainSecurityModule
