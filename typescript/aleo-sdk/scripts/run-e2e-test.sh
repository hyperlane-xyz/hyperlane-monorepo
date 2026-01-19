#!/usr/bin/env bash
set -e

echo "Running E2E tests (Docker container managed by testcontainers)"

# Set environment variables for test configuration
export ALEO_SKIP_PROOFS=true
export ALEO_SKIP_SUFFIXES=false
export ALEO_UPGRADE_AUTHORITY=""
export ALEO_CONSENSUS_VERSION_HEIGHTS="0,1,2,3,4,5,6,7,8,9,10,11"
export ALEO_ISM_MANAGER_SUFFIX="custom"
export ALEO_WARP_SUFFIX="usdc"

if [ -n "${ALEO_SDK_E2E_TEST}" ]; then
  echo "Running only ${ALEO_SDK_E2E_TEST} test"
  pnpm mocha --extension ts --node-option import=tsx/esm --file src/tests/e2e-test.setup.ts "src/tests/${ALEO_SDK_E2E_TEST}.e2e-test.ts"
else
  pnpm mocha --config .mocharc-e2e.json
fi

echo "Completed E2E tests"
