#!/usr/bin/env bash

function cleanup() {
  set +e
  pkill -f anvil
  rm -rf ./test-configs/anvil/deployments
  rm -f ./test-configs/anvil/chains/anvil2/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil3/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil4/addresses.yaml
  set -e
}

cleanup

echo "Starting anvil2, anvil3 and anvil4 chains for E2E tests"
anvil --chain-id 31338 -p 8555 --gas-price 1 > /dev/null &
anvil --chain-id 31347 -p 8600 --gas-price 1 > /dev/null &
anvil --chain-id 31348 -p 8601 --gas-price 1 > /dev/null &

echo "Running E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
  echo "Running only ${CLI_E2E_TEST} test"
  yarn mocha --config .mocharc-e2e.json "src/**/${CLI_E2E_TEST}.e2e-test.ts"
else
  yarn mocha --config .mocharc-e2e.json "src/**/*.e2e-test.ts"
fi

cleanup

echo "Completed E2E tests"
