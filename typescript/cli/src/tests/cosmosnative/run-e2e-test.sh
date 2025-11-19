#!/usr/bin/env bash
set -e

function setup() {
  echo "Starting hyp chain for Cosmos Native E2E tests"
  docker compose up --detach --wait

  if [[ $? -ne 0 ]]; then
    echo "Failure starting local cosmos chain"
    exit 1
  fi
}

function run() {
  echo "Running Cosmos Native E2E tests"
  if [ -n "${CLI_E2E_TEST}" ]; then
    echo "Running only ${CLI_E2E_TEST} test"
    pnpm mocha --config src/tests/cosmosnative/.mocharc-e2e.json "src/tests/cosmosnative/**/${CLI_E2E_TEST}.e2e-test.ts"
  else
    pnpm mocha --config src/tests/cosmosnative/.mocharc-e2e.json "src/tests/cosmosnative/**/core-deploy.e2e-test.ts"
  fi
}

function cleanup() {
  docker compose down
}

# Ensure cleanup runs even on error
trap cleanup EXIT

cleanup
setup
run

echo "Completed E2E tests"
