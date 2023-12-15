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

anvil --fork-url $RPC_URL --fork-retry-backoff 3 --compute-units-per-second 200 --gas-price 1 --silent &
ANVIL_PID=$!

while ! cast bn &> /dev/null; do
  sleep 1
done

# echo all subsequent commands
set -x

yarn ts-node ./scripts/check-deploy.ts -e $ENVIRONMENT -f $CHAIN -m $MODULE

# get balance
DEPLOYER="0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba"
BEFORE=$(cast balance $DEPLOYER --rpc-url http://localhost:8545)

yarn ts-node ./scripts/deploy.ts -e $ENVIRONMENT -f $CHAIN -m $MODULE

AFTER=$(cast balance $DEPLOYER --rpc-url http://localhost:8545)
DEPLOY_DELTA="$((BEFORE-AFTER))"

# build SDK to get the latest addresses
yarn --cwd ../sdk build

BEFORE=$(cast balance $DEPLOYER --rpc-url http://localhost:8545)
yarn ts-node ./scripts/check-deploy.ts -e $ENVIRONMENT -f $CHAIN --govern -m $MODULE

AFTER=$(cast balance $DEPLOYER --rpc-url http://localhost:8545)
GOVERN_DELTA="$((BEFORE-AFTER))"

yarn ts-node ./scripts/check-deploy.ts -e $ENVIRONMENT -f $CHAIN -m $MODULE
