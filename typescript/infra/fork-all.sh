ENVIRONMENT=$1
MODULE=$2

if [ -z "$ENVIRONMENT" ] || [ -z "$MODULE" ]; then
  echo "Usage: fork-all.sh <environment> <module>"
  exit 1
fi

CHAINS=`yarn tsx ./scripts/print-chain-metadatas.ts -e $ENVIRONMENT | \
    jq -r 'to_entries | map(select(.value.protocol=="ethereum")) | map(.key) ' | \
    tr -d '\"[],'`

# echo all subsequent commands
set -x

for CHAIN in $CHAINS; do
    ./fork.sh $ENVIRONMENT $MODULE $CHAIN
done
