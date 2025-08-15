source $HOME/hyperlane/runes.sh

export STAKE_RPC_URL="$(rpc mainnet3 ethereum)"
export NETWORK_MIDDLEWARE_SERVICE="0xD7dC9B366c027743D90761F71858BCa83C6899Ad"
export NETWORK_REGISTRY="0xC773b1011461e7314CF05f97d95aa8e92C1Fd8aA"
export EPOCH_START=1744672487
export EPOCH_DURATION=2592000
export EPOCH_AMOUNT=600000
export NUM_EPOCHS=3
export STAKED_WARP_ROUTE_ADDRESS="0x9F6E6d150977dabc82d5D4EaaBDB1F1Ab0D25F92"

forge script script/hyper/DistributeNetworkRewards.s.sol --sender 0xd96F4688873d00dc73B49F3fa2cC6925D7A64E8B -vvvv 

# Extract transaction fields, rename input to data, and omit nonce and chainId
TRANSACTIONS=$(cat broadcast/DistributeNetworkRewards.s.sol/1/dry-run/run-latest.json | jq '[.transactions[].transaction | {chainId, from, to, gas, value, data: .input}]')
  
# Write the transactions to a temporary file
echo "$TRANSACTIONS" > ./staking-transactions.json
