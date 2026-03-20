#!/usr/bin/env bash
set -e

echo "Running E2E tests"

# Set environment variables for Aleo test configuration
export ALEO_SKIP_PROOFS=true
export ALEO_SKIP_SUFFIXES=false
export ALEO_UPGRADE_AUTHORITY=""
export ALEO_CONSENSUS_VERSION_HEIGHTS="0,1,2,3,4,5,6,7,8,9,10,11"
export ALEO_ISM_MANAGER_SUFFIX="custom"
# ALEO_WARP_SUFFIX is set dynamically in test code to ensure uniqueness per test

# Ensure cleanup runs even on error
function cleanup() {
  echo "Cleaning up environment variables"
  unset ALEO_SKIP_PROOFS
  unset ALEO_SKIP_SUFFIXES
  unset ALEO_UPGRADE_AUTHORITY
  unset ALEO_CONSENSUS_VERSION_HEIGHTS
  unset ALEO_ISM_MANAGER_SUFFIX
}
trap cleanup EXIT

if [ -n "${CLI_E2E_TEST}" ]; then
  echo "Running only ${CLI_E2E_TEST} test"
  pnpm mocha --config src/tests/aleo/.mocharc-e2e.json "src/tests/aleo/**/${CLI_E2E_TEST}.e2e-test.ts"
else
  pnpm mocha --config src/tests/aleo/.mocharc-e2e.json "src/tests/aleo/**/*.e2e-test.ts"
fi

echo "Completed E2E tests"
