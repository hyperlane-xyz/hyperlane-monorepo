#!/bin/sh
set -e

# Set default registry URI, same as Dockerfile
REGISTRY_URI="/hyperlane-registry"

# Only update registry if REGISTRY_COMMIT is set
if [ -n "$REGISTRY_COMMIT" ]; then
  echo "Updating Hyperlane registry to commit: ${REGISTRY_COMMIT}"
  cd "$REGISTRY_URI"
  git fetch origin "$REGISTRY_COMMIT"
  git checkout "$REGISTRY_COMMIT"
fi

# Execute the main container command
exec "$@"
