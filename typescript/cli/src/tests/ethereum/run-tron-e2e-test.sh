#!/usr/bin/env bash
set -e

# Use Tron test stack - switches registry path, key, and timeouts
export TEST_STACK=tron

# Tests to skip for Tron (use evm_snapshot/evm_revert which Tron doesn't support)
SNAPSHOT_TESTS=(
	"warp-rebalancer"
	"warp-apply-ownership-updates"
	"warp-apply-simple-updates"
	"warp-apply-rebalancing-config"
)

# Build ignore patterns for mocha
IGNORE_PATTERNS=""
for test in "${SNAPSHOT_TESTS[@]}"; do
	IGNORE_PATTERNS="$IGNORE_PATTERNS --ignore \"src/tests/ethereum/**/${test}*.e2e-test.ts\""
done

echo "Running Tron E2E tests (using ethereum test harness with TEST_STACK=tron)"
echo "Skipping snapshot-dependent tests: ${SNAPSHOT_TESTS[*]}"

if [ -n "${CLI_E2E_TEST}" ]; then
	# Check if the requested test is in the skip list
	for test in "${SNAPSHOT_TESTS[@]}"; do
		if [[ "${CLI_E2E_TEST}" == *"${test}"* ]]; then
			echo "Skipping ${CLI_E2E_TEST} - uses EVM snapshots not supported by Tron"
			exit 0
		fi
	done

	echo "Running only ${CLI_E2E_TEST} test"
	pnpm mocha --config src/tests/ethereum/.mocharc-e2e.json "src/tests/ethereum/**/${CLI_E2E_TEST}.e2e-test.ts"
else
	eval pnpm mocha --config src/tests/ethereum/.mocharc-e2e.json $IGNORE_PATTERNS \"src/tests/ethereum/**/*.e2e-test.ts\"
fi

echo "Completed Tron E2E tests"
