#!/usr/bin/env bash

function cleanup() {
  set +e 
  pkill -f anvil
  rm -rf /tmp/anvil2
  rm -rf /tmp/anvil3
  set -e
  rm -f ./test-configs/anvil/chains/anvil2/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil3/addresses.yaml
}

cleanup

echo "Starting anvil2 and anvil3 chain"
anvil --chain-id 31347 -p 8600 --state /tmp/anvil2/state --gas-price 1 &
anvil --chain-id 31348 -p 8700 --state /tmp/anvil3/state --gas-price 1 &

echo "Running all tests"
yarn mocha --config .mocharc.json

cleanup

echo "Done all tests"