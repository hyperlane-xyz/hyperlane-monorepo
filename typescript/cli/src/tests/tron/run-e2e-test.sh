#!/usr/bin/env bash
set -e

TRON_SDK_DIR="$(dirname "$0")/../../../../tron-sdk/local-node"

function cleanup() {
	set +e
	echo "Stopping Tron node..."
	cd "$TRON_SDK_DIR" && docker-compose down 2>/dev/null
	rm -rf ./test-configs/test-registry/chains/tron1/addresses.yaml
	rm -rf ./test-configs/test-registry/chains/tron2/addresses.yaml
	rm -rf ./test-configs/test-registry/deployments
	set -e
}

# Ensure cleanup runs even on error
trap cleanup EXIT

cleanup

echo "Starting Tron local node for E2E tests..."
cd "$TRON_SDK_DIR" && docker-compose up -d

echo "Waiting for Tron node to be ready (this may take ~60 seconds)..."
# Wait for JSON-RPC to be available
MAX_RETRIES=60
RETRY_COUNT=0
until curl -s -X POST http://127.0.0.1:8545/jsonrpc \
	-H "Content-Type: application/json" \
	-d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' >/dev/null 2>&1; do
	RETRY_COUNT=$((RETRY_COUNT + 1))
	if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
		echo "Tron node failed to start after ${MAX_RETRIES} seconds"
		exit 1
	fi
	echo "Waiting for Tron JSON-RPC... (${RETRY_COUNT}/${MAX_RETRIES})"
	sleep 1
done

echo "Tron node is ready!"

# Return to CLI directory
cd - >/dev/null

echo "Running Tron E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
	echo "Running only ${CLI_E2E_TEST} test"
	pnpm mocha --config src/tests/tron/.mocharc-e2e.json "src/tests/tron/**/${CLI_E2E_TEST}.e2e-test.ts"
else
	pnpm mocha --config src/tests/tron/.mocharc-e2e.json "src/tests/tron/**/*.e2e-test.ts"
fi

echo "Completed Tron E2E tests"
