CHAINS=(bsc ethereum optimism base arbitrum)

for chain in "${CHAINS[@]}"; do
  echo "Processing $chain..."
  source script/hyper/$chain-merkle-distributors.production.mainnet.env
  forge script script/hyper/DistributeTokens.s.sol --sender 0x87fcEcb180E0275C22CEF213FF301816bB24E74B -vvvv
  
  # Extract transaction fields, rename input to data, and omit nonce and chainId
  TRANSACTIONS=$(cat broadcast/DistributeTokens.s.sol/1/dry-run/run-latest.json | jq '[.transactions[].transaction | {from, to, gas, value, data: .input}]')
  
    # Write the transactions to a temporary file
  echo "$TRANSACTIONS" > ./transactions_temp.json
  
  # Update the transactions.json file with the combined array
  jq -s '.[0] + .[1]' ./transactions.json ./transactions_temp.json > ./transactions.json.tmp
  mv ./transactions.json.tmp ./transactions.json
  
  # Clean up temporary file
  rm ./transactions_temp.json
done
