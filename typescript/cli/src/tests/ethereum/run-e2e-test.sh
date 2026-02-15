#!/usr/bin/env bash
set -e

ANVIL_PIDS=()

function kill_listeners_on_port() {
  local port="$1"
  local pids
  pids=$(
    ss -ltnp "sport = :${port}" 2>/dev/null \
      | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
      | sort -u
  )

  for pid in $pids; do
    kill "${pid}" 2>/dev/null || true
  done
}

function port_has_listener() {
  local port="$1"
  ss -ltn "sport = :${port}" 2>/dev/null \
    | awk 'NR > 1 { found = 1; exit } END { exit(found ? 0 : 1) }'
}

function wait_for_port_closed() {
  local port="$1"
  for _ in {1..40}; do
    if ! port_has_listener "${port}"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

function cleanup() {
  set +e
  for pid in "${ANVIL_PIDS[@]}"; do
    kill "${pid}" 2>/dev/null || true
  done
  for port in 8555 8600 8601 2496 18555 18600 18601; do
    kill_listeners_on_port "${port}"
    wait_for_port_closed "${port}" || true
  done
  rm -rf /tmp/anvil2
  rm -rf /tmp/anvil3
  rm -rf /tmp/anvil4
  rm -rf ./tmp
  rm -rf ./test-configs/anvil/deployments
  rm -f ./test-configs/anvil/chains/anvil2/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil3/addresses.yaml
  rm -f ./test-configs/anvil/chains/anvil4/addresses.yaml
  set -e
}

# Ensure cleanup runs even on error
trap cleanup EXIT

cleanup

function wait_for_port() {
  local port="$1"
  local name="$2"

  for _ in {1..50}; do
    if (echo >"/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  echo "Timed out waiting for ${name} on port ${port}" >&2
  return 1
}

echo "Starting anvil2, anvil3 and anvil4 chains for E2E tests"
anvil --chain-id 31338 -p 8555 --state /tmp/anvil2/state --gas-price 1 > /dev/null &
ANVIL_PIDS+=($!)
anvil --chain-id 31347 -p 8600 --state /tmp/anvil3/state --gas-price 1 > /dev/null &
ANVIL_PIDS+=($!)
anvil --chain-id 31348 -p 8601 --state /tmp/anvil4/state --gas-price 1 > /dev/null &
ANVIL_PIDS+=($!)

wait_for_port 8555 anvil2
wait_for_port 8600 anvil3
wait_for_port 8601 anvil4

echo "Running E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
  echo "Running only ${CLI_E2E_TEST} test"
  pnpm mocha --config src/tests/ethereum/.mocharc-e2e.json "src/tests/ethereum/**/${CLI_E2E_TEST}.e2e-test.ts"
else
  pnpm mocha --config src/tests/ethereum/.mocharc-e2e.json "src/tests/ethereum/**/*.e2e-test.ts"
fi

echo "Completed E2E tests"
