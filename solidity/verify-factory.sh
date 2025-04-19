CHAIN=$1
ADDRESS=$2

RPC_URL=$(cat ~/.hyperlane/chains/$CHAIN/metadata.yaml | yq '.rpcUrls[0].http')
API_KEY=$(gcloud secrets versions access latest --secret "explorer-api-keys" | jq -r ".$CHAIN")

IMPLEMENTATION=$(cast call $ADDRESS "implementation()(address)" --rpc-url $RPC_URL)
ISM_TYPE=$(cast call $IMPLEMENTATION --rpc-url $RPC_URL "moduleType()(uint8)")

# enum Types {
# 0    UNUSED,
# 1    ROUTING,
# 2    AGGREGATION,
# 3    LEGACY_MULTISIG,
# 4    MERKLE_ROOT_MULTISIG,
# 5    MESSAGE_ID_MULTISIG,
# 6    NULL, // used with relayer carrying no metadata
# 7    CCIP_READ,
# 8    ARB_L2_TO_L1,
# 9    WEIGHTED_MERKLE_ROOT_MULTISIG,
# 10   WEIGHTED_MESSAGE_ID_MULTISIG,
# 11   OP_L2_TO_L1
# }

if [ $? -ne 0 ]; then
    CONTRACT_NAME="StaticAggregationHook"
elif [ $ISM_TYPE -eq 1 ]; then
    CONTRACT_NAME="DomainRoutingIsm"
elif [ $ISM_TYPE -eq 2 ]; then
    CONTRACT_NAME="StaticAggregationIsm"
elif [ $ISM_TYPE -eq 4 ]; then
    CONTRACT_NAME="StaticMerkleRootMultisigIsm"
elif [ $ISM_TYPE -eq 5 ]; then
    CONTRACT_NAME="StaticMessageIdMultisigIsm"
fi

forge verify-contract $IMPLEMENTATION $CONTRACT_NAME \
    --rpc-url $RPC_URL \
    --verifier-api-key $API_KEY \
    --watch
