#!/bin/bash

ENVIRONMENT=$1
MODULE=$2
CHAIN=$3
WARP_ROUTE_ID=$4

if [ -z "$ENVIRONMENT" ] || [ -z "$MODULE" ] || [ -z "$CHAIN" ]; then
  echo "Usage: fork.sh <environment> <module> <chain> [warp_route_id]"
  exit 1
fi

# kill all child processes on exit
trap 'jobs -p | xargs -r kill 2>/dev/null || true' EXIT

# exit 1 on any subsequent failures
set -e

LOG_LEVEL=error yarn tsx ./scripts/run-anvil.ts -e $ENVIRONMENT -c $CHAIN &
ANVIL_PID=$!

while ! cast bn &> /dev/null; do
  sleep 1
done

# echo all subsequent commands
set -x

# Function to execute commands with or without --warpRouteId
execute_command() {
    local cmd="$1"
    if [ -n "$WARP_ROUTE_ID" ]; then
        $cmd --warpRouteId $WARP_ROUTE_ID
    else
        $cmd
    fi
}

echo "Checking deploy"
execute_command "yarn tsx ./scripts/check/check-deploy.ts -e $ENVIRONMENT -f $CHAIN -m $MODULE"

echo "Getting balance"
DEPLOYER="0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba"
BEFORE=$(cast balance $DEPLOYER --rpc-url http://localhost:8545)

echo "Deploying"
execute_command "yarn tsx ./scripts/deploy.ts -e $ENVIRONMENT -f $CHAIN -m $MODULE"

AFTER=$(cast balance $DEPLOYER --rpc-url http://localhost:8545)
DEPLOY_DELTA="$((BEFORE-AFTER))"

BEFORE=$(cast balance $DEPLOYER --rpc-url http://localhost:8545)
echo "Checking deploy with --govern"
execute_command "yarn tsx ./scripts/check/check-deploy.ts -e $ENVIRONMENT -f $CHAIN --govern -m $MODULE"

AFTER=$(cast balance $DEPLOYER --rpc-url http://localhost:8545)
GOVERN_DELTA="$((BEFORE-AFTER))"

echo "Checking deploy without --govern"
execute_command "yarn tsx ./scripts/check/check-deploy.ts -e $ENVIRONMENT -f $CHAIN -m $MODULE"