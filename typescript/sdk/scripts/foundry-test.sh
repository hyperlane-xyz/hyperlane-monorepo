#!/usr/bin/env bash

function cleanup() {
  set +e 
  pkill -f anvil
  rm -rf /tmp/anvil*
  set -e
}

cleanup

echo "Starting anvil chain"
anvil --chain-id 31337 -p 8545 --state /tmp/anvil1/state --gas-price 1 > /dev/null &

echo "Running mocha tests"
yarn mocha --config .mocharc.json './src/**/*.foundry-test.ts'

cleanup

echo "Done foundry tests"