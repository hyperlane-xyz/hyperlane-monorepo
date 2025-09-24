CHAINS=(bsc ethereum optimism base arbitrum)

ARTIFACTS_PATH="$HOME/hyperlane/merkle-distributor/scripts"
source $HOME/hyperlane/runes.sh

export STAKE_RPC_URL="$(rpc mainnet3 ethereum)"

# TODO: get staging stHYPER address from registry
export STAKED_WARP_ROUTE_ADDRESS="0x0C919509663cb273E156B706f065b9F7e6331891"

echo "[]" > ./transactions.json

for chain in "${CHAINS[@]}"; do
  echo "Processing $chain..."

  export DISTRIBUTION_RPC_URL="$(rpc mainnet3 $chain)"
  export DOMAIN_ID="$(meta $chain domainId)"

  export HYPER_RECIPIENT=$(jq -r ".[\"$DOMAIN_ID\"].HYPER" $ARTIFACTS_PATH/merkle-distributor-addresses.json)
  export STAKED_HYPER_RECIPIENT=$(jq -r ".[\"$DOMAIN_ID\"].stHYPER // \"0x0000000000000000000000000000000000000000\"" $ARTIFACTS_PATH/merkle-distributor-addresses.json)

  export HYPER_AMOUNT=$(jq -r ".[\"$DOMAIN_ID\"].HYPER" $ARTIFACTS_PATH/merkle-distributor-amounts.json)
  export STAKED_HYPER_AMOUNT=$(jq -r ".[\"$DOMAIN_ID\"].stHYPER // 0" $ARTIFACTS_PATH/merkle-distributor-amounts.json)
  
  forge script script/hyper/DistributeTokens.s.sol --sender 0x87fcEcb180E0275C22CEF213FF301816bB24E74B

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
