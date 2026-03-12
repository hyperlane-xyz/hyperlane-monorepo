#!/usr/bin/env bash
set -e

if [ -z "${SVM_SDK_E2E_TEST}" ]; then
  echo "Error: SVM_SDK_E2E_TEST env var is required."
  echo "Available tests: ism, hook, native-token, synthetic-token, collateral-token, provider, read-token"
  echo "Usage: SVM_SDK_E2E_TEST=ism pnpm test:e2e"
  exit 1
fi

echo "Running SVM SDK E2E test: ${SVM_SDK_E2E_TEST}"
pnpm mocha --config .mocharc-e2e.json --timeout 300000 "src/tests/${SVM_SDK_E2E_TEST}.e2e-test.ts"
echo "Completed SVM SDK E2E test: ${SVM_SDK_E2E_TEST}"
