#!/usr/bin/env bash
set -euo pipefail

case "${STARKNET_SDK_E2E_TEST:-}" in
  "")
    spec="src/tests/*.e2e-test.ts"
    echo "Running all Starknet SDK E2E tests"
    ;;
  ism|mailbox|hook|validator_announce|warp_core|warp_transfer)
    spec="src/tests/${STARKNET_SDK_E2E_TEST}.e2e-test.ts"
    ;;
  *)
    echo "Error: unknown STARKNET_SDK_E2E_TEST value '${STARKNET_SDK_E2E_TEST}'" >&2
    echo "Expected one of: ism, mailbox, hook, validator_announce, warp_core, warp_transfer" >&2
    exit 1
    ;;
esac

if [ -n "${STARKNET_SDK_E2E_TEST:-}" ]; then
  echo "Running Starknet SDK E2E shard: ${STARKNET_SDK_E2E_TEST}"
fi

pnpm mocha --config .mocharc-e2e.json "${spec}"
