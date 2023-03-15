ENVIRONMENT=$1

if [ -z "$ENVIRONMENT" ]; then
  echo "Usage: fork.sh <environment>"
  exit 1
fi

# TODO: make this more generic
if [ "$ENVIRONMENT" == "testnet3" ]; then
  RPC_URL="https://rpc.ankr.com/eth_goerli"
elif [ "$ENVIRONMENT" == "mainnet2" ]; then
  RPC_URL="https://rpc.ankr.com/eth_mainnet"
else
  echo "Unknown environment $ENVIRONMENT"
  exit 1
fi

# TODO: for network in environment
anvil --fork-url $RPC_URL &
ANVIL_PID=$!

while ! cast bn; do
  sleep 1
done

echo "=== Run checker against forked $ENVIRONMENT ===\n"
DEBUG=hyperlane:* yarn ts-node ./scripts/check-deploy.ts -e $ENVIRONMENT --fork

echo "=== Run core deployer against forked $ENVIRONMENT ===\n"
DEBUG=hyperlane:* yarn ts-node ./scripts/core.ts -e $ENVIRONMENT --fork

echo "=== Run govern against forked $ENVIRONMENT ===\n"
DEBUG=hyperlane:* yarn ts-node ./scripts/govern.ts -e $ENVIRONMENT --fork

echo "=== Run checker against forked $ENVIRONMENT ===\n"
DEBUG=hyperlane:* yarn ts-node ./scripts/check-deploy.ts -e $ENVIRONMENT --fork

kill $ANVIL_PID
