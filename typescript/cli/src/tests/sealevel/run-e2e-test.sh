#!/usr/bin/env bash
set -e

echo "Running Sealevel E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
  echo "Running only ${CLI_E2E_TEST} test"
  pnpm mocha --config src/tests/sealevel/.mocharc-e2e.json "src/tests/sealevel/**/${CLI_E2E_TEST}.e2e-test.ts"
else
  pnpm mocha --config src/tests/sealevel/.mocharc-e2e.json "src/tests/sealevel/**/*.e2e-test.ts"
fi

echo "Completed Sealevel E2E tests"
