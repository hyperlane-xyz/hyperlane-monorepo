#!/usr/bin/env bash

function setup_evm() {
  echo "Starting anvil2 and anvil3 chain for EVM E2E tests"
  anvil --chain-id 31338 -p 8555 --state /tmp/anvil2/state --gas-price 1 > /dev/null &
  anvil --chain-id 31347 -p 8600 --state /tmp/anvil3/state --gas-price 1 > /dev/null &
}

function run_evm() {
  echo "Running EVM E2E tests"
  if [ -n "${CLI_E2E_TEST}" ]; then
    echo "Running only ${CLI_E2E_TEST} test"
    yarn mocha --config .mocharc-e2e.json "src/tests/ethereum/**/${CLI_E2E_TEST}.e2e-test.ts"
  else
    yarn mocha --config .mocharc-e2e.json "src/tests/ethereum/**/*.e2e-test.ts"
  fi
}

function cleanup_evm() {
  set +e
  pkill -f anvil
  rm -rf ./tmp
  rm -rf ./test-configs/anvil/deployments
  rm -f ./test-configs/anvil/chains/anvil2/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil3/addresses.yaml
  set -e
}

function setup_cosmosnative() {
  echo "Starting hyp chain for Cosmos Native E2E tests"
  docker compose up --detach --wait

  if [[ $? -ne 0 ]]; then
    echo "Failure starting local cosmos chain"
    exit 1
  fi
}

function run_cosmosnative() {
  echo "Running Cosmos Native E2E tests"
  if [ -n "${CLI_E2E_TEST}" ]; then
    echo "Running only ${CLI_E2E_TEST} test"
    yarn mocha --config .mocharc-e2e.json "src/tests/cosmosnative/**/${CLI_E2E_TEST}.e2e-test.ts"
  else
    yarn mocha --config .mocharc-e2e.json "src/tests/cosmosnative/**/core-apply.e2e-test.ts"
  fi
}

function cleanup_cosmosnative() {
  docker compose down
}

# cleanup_evm
# setup_evm
# run_evm
# cleanup_evm

cleanup_cosmosnative
setup_cosmosnative
run_cosmosnative
cleanup_cosmosnative

echo "Completed E2E tests"
