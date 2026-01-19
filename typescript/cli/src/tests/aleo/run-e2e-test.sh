#!/usr/bin/env bash
set -e

echo "Running E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
  echo "Running only ${CLI_E2E_TEST} test"
  pnpm mocha --config src/tests/aleo/.mocharc-e2e.json "src/tests/aleo/**/${CLI_E2E_TEST}.e2e-test.ts"
else
  pnpm mocha --config src/tests/aleo/.mocharc-e2e.json "src/tests/aleo/**/*.e2e-test.ts"
fi

echo "Completed E2E tests"
