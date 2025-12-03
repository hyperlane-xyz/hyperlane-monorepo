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
export ALEO_SKIP_SUFFIXES=false
export ALEO_UPGRADE_AUTHORITY=""
export ALEO_CONSENSUS_VERSION_HEIGHTS="0,1,2,3,4,5,6,7,8,9,10,11"
export ALEO_ISM_MANAGER_SUFFIX="custom"
export ALEO_WARP_SUFFIX="usdc"

yarn mocha --config .mocharc-e2e.json

echo "Completed E2E tests"
