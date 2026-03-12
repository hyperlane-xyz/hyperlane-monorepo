#!/usr/bin/env bash
set -e

echo "Running SVM SDK E2E tests"

if [ -n "${SVM_SDK_E2E_TEST}" ]; then
  echo "Running only ${SVM_SDK_E2E_TEST} test"
  pnpm mocha --config .mocharc-e2e.json --timeout 300000 "src/tests/${SVM_SDK_E2E_TEST}.e2e-test.ts"
else
  pnpm mocha --config .mocharc-e2e.json --timeout 300000 \
    "src/tests/{ism,hook,native-token,synthetic-token,collateral-token,provider}.e2e-test.ts"
fi

echo "Completed SVM SDK E2E tests"
