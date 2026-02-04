#!/usr/bin/env bash
set -e

echo "Running Tron E2E tests"
if [ -n "${CLI_E2E_TEST}" ]; then
	echo "Running only ${CLI_E2E_TEST} test"
	pnpm mocha --config src/tests/tron/.mocharc-e2e.json "src/tests/tron/**/${CLI_E2E_TEST}.e2e-test.ts"
else
	pnpm mocha --config src/tests/tron/.mocharc-e2e.json "src/tests/tron/**/*.e2e-test.ts"
fi

echo "Completed Tron E2E tests"
