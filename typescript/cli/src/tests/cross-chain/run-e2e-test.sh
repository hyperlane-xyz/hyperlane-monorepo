#!/usr/bin/env bash
set -e

echo "Running E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
  echo "Running only ${CLI_E2E_TEST} test"
  yarn mocha --config src/tests/cross-chain/.mocharc-e2e.json "src/tests/cross-chain/**/${CLI_E2E_TEST}.e2e-test.ts"
else
  yarn mocha --config src/tests/cross-chain/.mocharc-e2e.json "src/tests/cross-chain/**/*.e2e-test.ts"
fi

echo "Completed E2E tests"
