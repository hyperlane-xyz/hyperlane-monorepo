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

echo "Waiting for Tron API to respond on 127.0.0.1:9090..."
for i in {1..60}; do
  if curl -s -X POST http://127.0.0.1:9090/wallet/getnowblock > /dev/null; then
    echo "Tron API is LIVE!"
    break
  fi
  echo "Still waiting for API... ($((i*5))s)"
  sleep 5
done

echo "Running E2E tests"

pnpm mocha --config .mocharc-e2e.json

echo "Completed E2E tests"
