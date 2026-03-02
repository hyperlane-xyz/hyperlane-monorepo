#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${1:-local/shovel/shovel.local.json}"
SHOVEL_BIN="${SHOVEL_BIN:-./shovel}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL environment variable required" >&2
  exit 1
fi

if [[ ! -x "${SHOVEL_BIN}" ]]; then
  echo "Shovel binary not found/executable at ${SHOVEL_BIN}" >&2
  echo "Run: pnpm shovel:download" >&2
  exit 1
fi

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "Config not found: ${CONFIG_PATH}" >&2
  echo "Run: pnpm shovel:config" >&2
  exit 1
fi

TMP_CONFIG="$(mktemp)"
cleanup() {
  rm -f "${TMP_CONFIG}"
}
trap cleanup EXIT

node -e '
const fs = require("fs");
const inPath = process.argv[1];
const outPath = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;
const cfg = JSON.parse(fs.readFileSync(inPath, "utf8"));
cfg.pg_url = databaseUrl;
fs.writeFileSync(outPath, JSON.stringify(cfg));
' "${CONFIG_PATH}" "${TMP_CONFIG}"

exec "${SHOVEL_BIN}" -config "${TMP_CONFIG}"
