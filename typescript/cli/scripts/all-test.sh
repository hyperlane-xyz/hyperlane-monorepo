#!/usr/bin/env bash

function cleanup() {
  set +e 
  pkill -f anvil
  rm -rf /tmp/anvil2
  rm -rf /tmp/anvil3
  rm -f ./test-configs/anvil/chains/anvil2/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil3/addresses.yaml
  set -e
  
}

cleanup

echo "Starting anvil2 and anvil3 chain"
anvil --chain-id 31338 -p 8555 --state /tmp/anvil2/state --gas-price 1 > /dev/null &
anvil --chain-id 31347 -p 8600 --state /tmp/anvil3/state --gas-price 1 > /dev/null &

echo "Running all tests"
yarn mocha --config .mocharc.json

cleanup

echo "Done all tests"