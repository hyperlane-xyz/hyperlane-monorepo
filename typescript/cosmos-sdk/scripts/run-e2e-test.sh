#!/usr/bin/env bash

function cleanup() {
  docker compose down
}

cleanup

echo "Preparing E2E tests"
docker compose up --detach --wait

if [[ $? -ne 0 ]]; then
  echo "Failure starting local cosmos chain"
  exit 1
fi

echo "Running E2E tests"
yarn mocha --config .mocharc-e2e.json

cleanup

echo "Completed E2E tests"
