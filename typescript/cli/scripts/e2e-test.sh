#!/usr/bin/env bash

function cleanup() {
  set +e 
  pkill -f anvil
  rm -rf /tmp/anvil*
  set -e

  rm -f ./test-configs/anvil/chains/anvil1/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil2/addresses.yaml
}

cleanup

echo "Starting anvil1 and anvil2 chain"
anvil --chain-id 31337 -p 8545 --state /tmp/anvil1/state --gas-price 1 > /dev/null &
anvil --chain-id 31338 -p 8555 --state /tmp/anvil2/state --gas-price 1 > /dev/null &

echo "Running e2e tests"
yarn mocha './src/**/*.e2e-test.ts'

cleanup

echo "Done e2e tests"