#!/usr/bin/env bash
set -e

DOCKER_COMPOSE_CMD=""

function resolve_docker_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker compose"
    return 0
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker-compose"
    return 0
  fi

  echo "Missing Docker Compose command. Install either 'docker compose' plugin or 'docker-compose' binary." >&2
  exit 1
}

function docker_compose() {
  # shellcheck disable=SC2086
  ${DOCKER_COMPOSE_CMD} "$@"
}

function setup() {
  echo "Starting hyp chain for Cosmos Native E2E tests"
  docker_compose up --detach --wait

  if [[ $? -ne 0 ]]; then
    echo "Failure starting local cosmos chain"
    exit 1
  fi
}

function run() {
  echo "Running Cosmos Native E2E tests"
  if [ -n "${CLI_E2E_TEST}" ]; then
    echo "Running only ${CLI_E2E_TEST} test"
    pnpm mocha --config src/tests/cosmosnative/.mocharc-e2e.json "src/tests/cosmosnative/**/${CLI_E2E_TEST}.e2e-test.ts"
  else
    pnpm mocha --config src/tests/cosmosnative/.mocharc-e2e.json "src/tests/cosmosnative/**/core-deploy.e2e-test.ts"
  fi
}

function cleanup() {
  docker_compose down
}

# Ensure cleanup runs even on error
trap cleanup EXIT

resolve_docker_compose_cmd
cleanup
setup
run

echo "Completed E2E tests"
