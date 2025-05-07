CHAIN=${1:-bsc}
ADDRESS=$2

# from IInterchainSecurityModule.sol
ISM_TYPES=(UNUSED ROUTING AGGREGATION LEGACY_MULTISIG MERKLE_ROOT_MULTISIG MESSAGE_ID_MULTISIG NULL CCIP_READ ARB_L2_TO_L1)

source ~/hyperlane/runes.sh

ISM_INDEX=$(cast call $ADDRESS "moduleType() returns (uint8)" \
    --rpc-url $(rpc mainnet3 $CHAIN))

ISM_TYPE="${ISM_TYPES[$ISM_INDEX]}"

# if ISM_TYPE == "NULL"
if [ "$ISM_TYPE" == "NULL" ]; then
    CONTRACT="PausableIsm"
    CONSTRUCTOR_ARGS=$(cast abi-encode "constructor(address owner)" 0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba)
fi

forge verify-contract $ADDRESS $CONTRACT \
    --constructor-args $CONSTRUCTOR_ARGS \
    --rpc-url $(rpc mainnet3 $CHAIN) \
    --etherscan-api-key $(explorerkey $CHAIN) \
    --watch
