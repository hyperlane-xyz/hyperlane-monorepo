#!/bin/sh
set -e

VALID_SERVICES="rebalancer warp-monitor ccip-server keyfunder relayer fee-quoting"

if [ -z "$SERVICE_NAME" ]; then
  echo "ERROR: SERVICE_NAME env var is required." >&2
  echo "Valid services: $VALID_SERVICES" >&2
  exit 1
fi

BUNDLE_PATH="/app/services/${SERVICE_NAME}/index.js"

if [ ! -f "$BUNDLE_PATH" ]; then
  echo "ERROR: No bundle found for service '${SERVICE_NAME}' at ${BUNDLE_PATH}" >&2
  echo "Valid services: $VALID_SERVICES" >&2
  exit 1
fi

exec node "$BUNDLE_PATH" "$@"
