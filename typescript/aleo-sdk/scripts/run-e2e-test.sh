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
  echo "Failure starting local aleo devnode"
  exit 1
fi

echo "Running E2E tests"

export ALEO_SKIP_PROOFS=true
export ALEO_USE_ORIGINAL_PROGRAM_IDS=false
export ALEO_UPGRADE_AUTHORITY=""

yarn mocha --config .mocharc-e2e.json

echo "Completed E2E tests"
