ENVIRONMENT=$1
MODULE=$2
CHAIN=$3

if [ -z "$ENVIRONMENT" ] || [ -z "$MODULE" ] || [ -z "$CHAIN" ]; then
  echo "Usage: fork.sh <environment> <module> <chain>"
  exit 1
fi

# kill all child processes on exit
trap 'jobs -p | xargs -r kill' EXIT

# exit 1 on any subsequent failures
set -e

RPC_URL=`yarn ts-node ./scripts/print-chain-metadatas.ts -e $ENVIRONMENT | jq -r ".$CHAIN.rpcUrls[0].http"`

anvil --fork-url $RPC_URL --silent &
ANVIL_PID=$!

while ! cast bn &> /dev/null; do
  sleep 1
done

echo "=== Run $MODULE checker against forked $CHAIN ==="
yarn ts-node ./scripts/check-deploy.ts -e $ENVIRONMENT -f $CHAIN -m $MODULE

echo "=== Run $MODULE deployer against forked $CHAIN ==="
yarn ts-node ./scripts/deploy.ts -e $ENVIRONMENT -f $CHAIN -m $MODULE

# build SDK to get the latest addresses
yarn --cwd ../sdk build

echo "=== Run $MODULE govern against forked $CHAIN ==="
yarn ts-node ./scripts/check-deploy.ts -e $ENVIRONMENT -f $CHAIN --govern -m $MODULE

echo "=== Run $MODULE checker against forked $CHAIN after governance ==="
yarn ts-node ./scripts/check-deploy.ts -e $ENVIRONMENT -f $CHAIN -m $MODULE
