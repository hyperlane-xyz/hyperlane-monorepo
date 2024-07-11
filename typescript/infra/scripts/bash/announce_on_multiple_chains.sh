#!/bin/bash

# Example: ./announce_on_multiple_chains.sh "https://hyperlane-v3-validator-signatures-everstake-one-bsc.s3.us-east-2.amazonaws.com https://hyperlane-v3-validator-signatures-everstake-one-celo.s3.us-east-2.amazonaws.com" "bsc celo"

# Check if the correct number of arguments is provided
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 's3url1 s3url2 ...' 'chain1 chain2 ...'"
    exit 1
fi

# Convert the argument strings into arrays
IFS=' ' read -r -a list1 <<< "$1"
IFS=' ' read -r -a list2 <<< "$2"

# Check if both lists have the same length
if [ "${#list1[@]}" -ne "${#list2[@]}" ]; then
    echo "Error: Both lists must have the same length."
    exit 1
fi

# Iterate through both lists simultaneously
for i in "${!list1[@]}"; do
    location="${list1[i]}"
    chain="${list2[i]}"

    echo "Executing: yarn tsx ../announce-validators.ts -e mainnet3 --location $location --chain $chain"
    yarn tsx ../announce-validators.ts -e mainnet3 --location "$location" --chain "$chain"
done
