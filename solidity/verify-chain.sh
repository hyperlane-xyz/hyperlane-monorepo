CHAIN=$1

KEYS="staticAggregationHookFactory domainRoutingIsmFactory staticAggregationIsmFactory staticMerkleRootMultisigIsmFactory staticMessageIdMultisigIsmFactory"

for KEY in $KEYS; do
  ADDRESS=$(cat ~/.hyperlane/chains/$CHAIN/addresses.yaml | yq -r ".$KEY")
  echo "Verifying $KEY at $ADDRESS"
  ./verify-factory.sh $CHAIN $ADDRESS
done
