#!/usr/bin/env bash
set -e

DOCKER_COMPOSE_CMD=()

function resolve_docker_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD=(docker compose)
    return 0
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD=(docker-compose)
    return 0
  fi

  echo "Missing Docker Compose command. Install either 'docker compose' plugin or 'docker-compose' binary." >&2
  exit 1
}

function docker_compose() {
  if [ "${#DOCKER_COMPOSE_CMD[@]}" -eq 0 ]; then
    echo "Docker Compose command has not been resolved." >&2
    return 1
  fi
  "${DOCKER_COMPOSE_CMD[@]}" "$@"
}

function setup() {
  echo "Starting hyp chain for Cosmos Native E2E tests"
  docker_compose up --detach --wait
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
  if [ "${#DOCKER_COMPOSE_CMD[@]}" -eq 0 ]; then
    return 0
  fi
  docker_compose down || true
}

resolve_docker_compose_cmd

# Ensure cleanup runs even on error
trap cleanup EXIT

cleanup
setup
run

echo "Completed E2E tests"
