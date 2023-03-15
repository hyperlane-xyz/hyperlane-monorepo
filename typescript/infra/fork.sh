ENVIRONMENT=$1

if [ -z "$ENVIRONMENT" ]; then
  echo "Usage: fork.sh <environment>"
  exit 1
fi

if [ "$ENVIRONMENT" == "testnet3" ]; then
  FORK_CHAIN="goerli"
  RPC_URL="https://goerli.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161"
elif [ "$ENVIRONMENT" == "mainnet2" ]; then
  FORK_CHAIN="ethereum"
  RPC_URL="https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161"
else
  echo "Unknown environment $ENVIRONMENT"
  exit 1
fi

anvil --fork-url $RPC_URL --block-time 3 --silent &
ANVIL_PID=$!

while ! cast bn; do
  sleep 1
done

echo "=== Run checker against forked $ENVIRONMENT ==="
DEBUG=hyperlane:* yarn ts-node ./scripts/check-deploy.ts -e $ENVIRONMENT --fork $FORK_CHAIN

echo "=== Run core deployer against forked $ENVIRONMENT ==="
DEBUG=hyperlane:* yarn ts-node ./scripts/core.ts -e $ENVIRONMENT --fork $FORK_CHAIN

echo "=== Run govern against forked $ENVIRONMENT ==="
DEBUG=hyperlane:* yarn ts-node ./scripts/govern.ts -e $ENVIRONMENT --fork $FORK_CHAIN

echo "=== Run checker against forked $ENVIRONMENT ==="
DEBUG=hyperlane:* yarn ts-node ./scripts/check-deploy.ts -e $ENVIRONMENT --fork $FORK_CHAIN

SUCCESS=$?

kill $ANVIL_PID

exit $SUCCESS
