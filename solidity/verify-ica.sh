CHAIN=${1:-bsc}

source ~/hyperlane/runes.sh

ROUTER_IMPLEMENTATION=$(cast implementation $(addr $CHAIN interchainAccountRouter) --rpc-url $(rpc mainnet3 $CHAIN))

forge verify-contract $ROUTER_IMPLEMENTATION InterchainAccountRouter \
    --constructor-args $(cast abi-encode "constructor(address mailbox)" $(addr $CHAIN mailbox)) \
    --rpc-url $(rpc mainnet3 $CHAIN) \
    --etherscan-api-key $(explorerkey $CHAIN) \
    --watch

IMPLEMENTATION_SLOT=$(forge inspect InterchainAccountRouter storage --json \
  | jq -r '.storage[] | select(.label=="implementation") .slot')

IMPLEMENTATION_ADDRESS=$(cast parse-bytes32-address $(cast storage $(addr $CHAIN interchainAccountRouter) $IMPLEMENTATION_SLOT \
    --rpc-url $(rpc mainnet3 $CHAIN)))

forge verify-contract $IMPLEMENTATION_ADDRESS OwnableMulticall \
    --constructor-args $(cast abi-encode "constructor(address owner)" $(addr $CHAIN interchainAccountRouter)) \
    --rpc-url $(rpc mainnet3 $CHAIN) \
    --etherscan-api-key $(explorerkey $CHAIN) \
    --watch
