CHAINS=(ethereum bsc arbitrum optimism base)
for chain in "${CHAINS[@]}"; do
  echo "Processing $chain..."
  source script/hyper/$chain-merkle-distributors.production.mainnet.env
  forge script script/hyper/DistributeTokens.s.sol --sender 0x87fcEcb180E0275C22CEF213FF301816bB24E74B
  cat broadcast/DistributeTokens.s.sol/1/dry-run/run-latest.json | jq '.transactions' >> ./transactions.json
done
