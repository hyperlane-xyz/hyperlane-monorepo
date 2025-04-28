#!/bin/bash

if [ -f "$HOME/.bashrc" ]; then
    source "$HOME/.bashrc"
fi

# Check if environment argument is provided
if [ "$1" != "mainnet3" ] && [ "$1" != "testnet4" ]; then
    echo "Usage: $0 <mainnet3|testnet4>"
    exit 1
fi

ENVIRONMENT=$1

# Set the deployer address and vanguard addresses based on environment
# Define the chains to check for each environment
if [ "$ENVIRONMENT" = "mainnet3" ]; then
    DEPLOYER="0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba"
    CHAINS=("base" "bsc" "arbitrum" "optimism" "ethereum")
    VANGUARD_ADDRESSES=("0xbe2e6b1ce045422a08a3662fffa3fc5f114efc3d"
                        "0xdbcd22e5223f5d0040398e66dbb525308f27c655"
                        "0x226b721316ea44aad50a10f4cc67fc30658ab4a9"
                        "0xcdd728647ecd9d75413c9b780de303b1d1eb12a5"
                        "0x5401627b69f317da9adf3d6e1e1214724ce49032"
                        "0x6fd953d1cbdf3a79663b4238898147a6cf36d459")
else
    DEPLOYER="0xfaD1C94469700833717Fa8a3017278BC1cA8031C"
    CHAINS=("basesepolia" "bsctestnet" "arbitrumsepolia" "optimismsepolia" "sepolia")
    VANGUARD_ADDRESSES=("0x2c9209efcaff2778d945e18fb24174e16845dc62"
                        "0x939043d9db00f6ada1b742239beb7ddd5bf82096"
                        "0x45b58e4d46a89c003cc7126bd971eb3794a66aeb"
                        "0x1f4fdb150e8c9fda70687a2fd481e305af1e7f8e"
                        "0xe41b227e7aaaf7bbd1d60258de0dd76a11a0c3fc"
                        "0xb1d77c39166972c0873b6ae016d1a54ec3ce289b"
                        "0x59f4ee751c5ef680382bdf0bebfa92f278e17284"
                        "0xd4df81362263d4fbb9ccf6002b0a028b893701b0")
fi

# Function to get AWS credentials from gcloud secrets
get_aws_credentials() {
    local vanguard=$1

    # Get AWS credentials from gcloud secrets
    export AWS_ACCESS_KEY_ID=$(gcloud secrets versions access latest --secret="${vanguard}-${ENVIRONMENT}-relayer-aws-access-key-id")
    export AWS_SECRET_ACCESS_KEY=$(gcloud secrets versions access latest --secret="${vanguard}-${ENVIRONMENT}-relayer-aws-secret-access-key")
    export AWS_KMS_KEY_ID="alias/${vanguard}-${ENVIRONMENT}-key-relayer"
}

# Function to check balance and send funds
check_and_send() {
    local vanguard_index=$1
    local chain=$2
    local vanguard_address=${VANGUARD_ADDRESSES[$vanguard_index]}

    echo "Checking vanguard$vanguard_index ($vanguard_address) on $chain..."

    # Get the balance of the current wallet
    balance=$(cast balance $vanguard_address --rpc-url $(rpc $ENVIRONMENT $chain))
    pretty_balance=$(cast fw $balance)
    echo "Balance: $pretty_balance"

    # If pretty_balance is greater than 0, send funds to deployer
    if [ $(echo "$pretty_balance > 0" | bc) -eq 1 ]; then
        echo "Sending $pretty_balance funds from vanguard$vanguard_index ($vanguard_address) to $DEPLOYER on $chain..."
        # Subtract 0.01 ETH (10000000000000000 wei) for sepolia, 0.001 ETH (1000000000000000 wei) for ethereum, 0.0001 ETH (100000000000000 wei) for other chains
        if [ "$chain" = "sepolia" ]; then
            adjusted_balance=$(echo "$balance - 10000000000000000" | bc)
        elif [ "$chain" = "ethereum" ]; then
            adjusted_balance=$(echo "$balance - 1000000000000000" | bc)
        else
            adjusted_balance=$(echo "$balance - 100000000000000" | bc)
        fi
        if [ $(echo "$adjusted_balance > 0" | bc) -eq 1 ]; then
            cast send $DEPLOYER --value $adjusted_balance --rpc-url $(rpc $ENVIRONMENT $chain) --aws
        else
            echo "Insufficient balance after gas cost deduction."
        fi
    fi
    echo "------------------------------------------------------------------------------------------------------------------------------------------------------"
}

# Set the range based on environment
if [ "$ENVIRONMENT" = "mainnet3" ]; then
    RANGE="1 2 3 4 5"
else
    RANGE="0 1 2 3 4 5 6 7"
fi

# Iterate through vanguards based on environment
for i in $RANGE; do
    echo "######################################################################################################################################################"
    echo "Processing vanguard$i..."

    # Get AWS credentials once per vanguard
    get_aws_credentials "vanguard$i"

    # Check each chain
    for chain in "${CHAINS[@]}"; do
        check_and_send $i $chain
    done
done

echo "Funds reclamation process completed!"
