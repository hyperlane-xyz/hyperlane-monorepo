#!/usr/bin/env bash

function cleanup() {
  set +e
  pkill -f anvil
  rm -rf /tmp/anvil1
  rm -rf /tmp/anvil2
  rm -rf /tmp/anvil3
  rm -f ./test-configs/anvil/chains/anvil1/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil2/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil3/addresses.yaml
  set -e
}

cleanup

echo "Starting anvil1, anvil2 and anvil3 chain for E2E tests"
# Anvil1 should be used only for core commands e2e testing to avoid interfierence with other e2e tests
anvil --chain-id 31337 -p 8545 --state /tmp/anvil1/state --gas-price 1 > /dev/null &
anvil --chain-id 31338 -p 8555 --state /tmp/anvil2/state --gas-price 1 > /dev/null &
anvil --chain-id 31347 -p 8600 --state /tmp/anvil3/state --gas-price 1 > /dev/null &

echo "Running E2E tests"
yarn mocha --config .mocharc-e2e.json

cleanup

echo "Completed E2E tests"
