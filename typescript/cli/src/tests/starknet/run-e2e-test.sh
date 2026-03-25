#!/usr/bin/env bash
set -e

echo "Running E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
  echo "Running only ${CLI_E2E_TEST} test"
  pnpm mocha --config src/tests/starknet/.mocharc-e2e.json "src/tests/starknet/**/${CLI_E2E_TEST}.e2e-test.ts"
else
  pnpm mocha --config src/tests/starknet/.mocharc-e2e.json "src/tests/starknet/**/*.e2e-test.ts"
fi

echo "Completed E2E tests"
