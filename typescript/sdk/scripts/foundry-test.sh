#!/usr/bin/env bash
set -Eeuo pipefail

# Store the PID of the anvil process we start and the temp directory
ANVIL_PID=""
ANVIL_TEMP_DIR=""

function cleanup() {
  set +e 
  
  # Only kill the anvil process we started, if it exists
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    echo "Stopping anvil (PID: $ANVIL_PID)"
    kill "$ANVIL_PID"
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  
  # Clean up the unique temporary directory we created
  if [[ -n "$ANVIL_TEMP_DIR" && -d "$ANVIL_TEMP_DIR" ]]; then
    echo "Cleaning up temporary directory: $ANVIL_TEMP_DIR"
    rm -rf "$ANVIL_TEMP_DIR"
  fi
  
  set -e
}

# Set up trap to handle script interruption/termination
trap cleanup EXIT
trap 'echo "Received interrupt signal"; exit 130' INT
trap 'echo "Received termination signal"; exit 143' TERM
trap 'echo "Received quit signal"; exit 131' QUIT

# Create a unique temporary directory for this anvil instance
ANVIL_TEMP_DIR=$(mktemp -d -t anvil.XXXXXX)
echo "Using temporary directory: $ANVIL_TEMP_DIR"

echo "Starting anvil chain"
anvil --chain-id 31337 -p 8545 --state "$ANVIL_TEMP_DIR/state" --gas-price 1 > /dev/null &
ANVIL_PID=$!

echo "Anvil started with PID: $ANVIL_PID"
echo "Running mocha tests"
pnpm mocha --config .mocharc.json './src/**/*.foundry-test.ts'

echo "Done foundry tests"
