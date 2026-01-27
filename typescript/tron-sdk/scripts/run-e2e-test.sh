#!/usr/bin/env bash
set -e

function cleanup() {
  docker compose down
}

# Ensure cleanup runs even on error
trap cleanup EXIT

cleanup

echo "Preparing E2E tests"
docker compose up --detach --wait

if [[ $? -ne 0 ]]; then
  echo "Failure starting local tron devnode"
  exit 1
fi

echo "Waiting for Tron devnode to initialize..."

# wait for certain log in the container, timeout after 2min
start_time=$(date +%s)
timeout=120

(docker compose logs -f | grep -m 1 "HD Wallet") &
grep_pid=$!

while true; do
  current_time=$(date +%s)
  elapsed=$((current_time - start_time))

  if ! kill -0 $grep_pid 2>/dev/null; then
    echo "Tron devnode is ready!"
    break
  fi

  if [ $elapsed -ge $timeout ]; then
    echo "Error: Timeout reached waiting for Tron devnode"
    kill $grep_pid 2>/dev/null
    exit 1
  fi

  sleep 2
done

echo "Running E2E tests"

pnpm mocha --config .mocharc-e2e.json

echo "Completed E2E tests"
