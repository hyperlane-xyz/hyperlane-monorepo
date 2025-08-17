CHAINS=(bsc ethereum optimism base arbitrum)

ARTIFACTS_PATH="$HOME/hyperlane/merkle-distributor/scripts"
source $HOME/hyperlane/runes.sh

export STAKE_RPC_URL="$(rpc mainnet3 ethereum)"
export STAKED_WARP_ROUTE_ADDRESS="0x9F6E6d150977dabc82d5D4EaaBDB1F1Ab0D25F92"

echo "[]" > ./transactions.json

TEST_AMOUNT=10000000000000000

for chain in "${CHAINS[@]}"; do
  echo "Processing $chain..."

  export DISTRIBUTION_RPC_URL="$(rpc mainnet3 $chain)"
  export DOMAIN_ID="$(meta $chain domainId)"

  export HYPER_RECIPIENT=$(jq -r ".[\"$DOMAIN_ID\"].HYPER" $ARTIFACTS_PATH/merkle-distributor-addresses.json)
  export STAKED_HYPER_RECIPIENT=$(jq -r ".[\"$DOMAIN_ID\"].stHYPER // \"0x0000000000000000000000000000000000000000\"" $ARTIFACTS_PATH/merkle-distributor-addresses.json)

  # export HYPER_AMOUNT=$(jq -r ".[\"$DOMAIN_ID\"].HYPER" $ARTIFACTS_PATH/merkle-distributor-amounts.json)
  export HYPER_AMOUNT=$TEST_AMOUNT
  # export STAKED_HYPER_AMOUNT=$(jq -r ".[\"$DOMAIN_ID\"].stHYPER // 0" $ARTIFACTS_PATH/merkle-distributor-amounts.json)
  if [ "$chain" == "ethereum" ] || [ "$chain" == "bsc" ]; then
    export STAKED_HYPER_AMOUNT=$TEST_AMOUNT
  else
    export STAKED_HYPER_AMOUNT=0
  fi
  
  forge script script/hyper/DistributeTokens.s.sol --sender 0x2522d3797411Aff1d600f647F624713D53b6AA11

  # Extract transaction fields, rename input to data, and omit nonce and chainId
  TRANSACTIONS=$(cat broadcast/DistributeTokens.s.sol/1/dry-run/run-latest.json | jq '[.transactions[].transaction | {chainId, from, to, gas, value, data: .input}]')
  
    # Write the transactions to a temporary file
  echo "$TRANSACTIONS" > ./transactions_temp.json
  
  # Update the transactions.json file with the combined array
  jq -s '.[0] + .[1]' ./transactions.json ./transactions_temp.json > ./transactions.json.tmp
  mv ./transactions.json.tmp ./transactions.json
  
  # Clean up temporary file
  rm ./transactions_temp.json
done
