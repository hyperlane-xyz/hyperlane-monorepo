#!/usr/bin/env bash

function cleanup() {
  rm -f ./test-configs/anvil/chains/anvil1/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil2/addresses.yaml
}

cleanup

echo "Starting anvil1 and anvil2 chain"
anvil --chain-id 31347 -p 8600 --state /tmp/anvil1/state --gas-price 1 > /dev/null &
anvil --chain-id 31348 -p 8700 --state /tmp/anvil2/state --gas-price 1 > /dev/null &

echo "Running all tests"
yarn mocha --config .mocharc.json

cleanup

echo "Done all tests"