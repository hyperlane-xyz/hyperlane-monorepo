#!/usr/bin/env bash
set -e

function cleanup() {
  set +e
  pkill -f anvil
  rm -rf ./tmp
  rm -rf ./test-configs/anvil/deployments
  rm -rf /tmp/anvil2 /tmp/anvil3 /tmp/anvil4
  rm -f ./test-configs/anvil/chains/anvil2/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil3/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil4/addresses.yaml
  set -e
}

# Ensure cleanup runs even on error
trap cleanup EXIT

cleanup

function wait_for_rpc() {
  local url="$1"
  local label="$2"
  local attempts=40
  local i

  for ((i = 1; i <= attempts; i++)); do
    if curl -sS -X POST \
      -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
      "$url" | grep -q '"result"'; then
      return 0
    fi
    sleep 0.5
  done

  echo "RPC $label did not become ready at $url"
  exit 1
}

echo "Starting anvil2, anvil3 and anvil4 chains for E2E tests"
anvil --chain-id 31338 -p 8555 --state /tmp/anvil2/state --gas-price 1 > /dev/null &
anvil --chain-id 31347 -p 8600 --state /tmp/anvil3/state --gas-price 1 > /dev/null &
anvil --chain-id 31348 -p 8601 --state /tmp/anvil4/state --gas-price 1 > /dev/null &
wait_for_rpc "http://127.0.0.1:8555" "anvil2"
wait_for_rpc "http://127.0.0.1:8600" "anvil3"
wait_for_rpc "http://127.0.0.1:8601" "anvil4"

echo "Running E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
  echo "Running only ${CLI_E2E_TEST} test"
  pnpm mocha --config src/tests/ethereum/.mocharc-e2e.json "src/tests/ethereum/**/${CLI_E2E_TEST}.e2e-test.ts"
else
  pnpm mocha --config src/tests/ethereum/.mocharc-e2e.json "src/tests/ethereum/**/*.e2e-test.ts"
fi

echo "Completed E2E tests"
