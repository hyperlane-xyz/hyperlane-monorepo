#!/usr/bin/env bash

echo "Running E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
  echo "Running only ${CLI_E2E_TEST} test"
  yarn mocha --config src/tests/ethereum/.mocharc-e2e.json "src/tests/ethereum/**/${CLI_E2E_TEST}.e2e-test.ts"
else
  yarn mocha --config src/tests/ethereum/.mocharc-e2e.json "src/tests/ethereum/**/*.e2e-test.ts"
fi

echo "Completed E2E tests"
