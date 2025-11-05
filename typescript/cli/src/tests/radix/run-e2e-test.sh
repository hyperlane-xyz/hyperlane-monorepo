#!/usr/bin/env bash
echo "Running E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
  echo "Running only ${CLI_E2E_TEST} test"
  yarn mocha --config src/tests/radix/.mocharc-e2e.json "src/tests/radix/**/${CLI_E2E_TEST}.e2e-test.ts"
else
  yarn mocha --config src/tests/radix/.mocharc-e2e.json "src/tests/radix/**/*.e2e-test.ts"
fi

echo "Completed E2E tests"
