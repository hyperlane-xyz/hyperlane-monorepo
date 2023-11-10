ENVIRONMENT=$1
MODULE=$2

if [ -z "$ENVIRONMENT" ] || [ -z "$MODULE" ]; then
  echo "Usage: fork-all.sh <environment> <module>"
  exit 1
fi

CHAINS=`yarn ts-node ./scripts/print-chain-metadatas.ts -e $ENVIRONMENT | \
    jq -r 'to_entries | map(select(.value.protocol=="ethereum")) | map(.key) ' | \
    tr -d '\"[],'`

for CHAIN in $CHAINS; do
    echo "=== Run $MODULE on $CHAIN ==="
    ./fork.sh $ENVIRONMENT $MODULE $CHAIN
done
