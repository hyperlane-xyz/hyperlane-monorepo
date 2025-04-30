#!/bin/sh
set -e

# Set default registry URI, same as Dockerfile
REGISTRY_URI="/hyperlane-registry"

# Only update registry if REGISTRY_COMMIT is set
if [ -n "$REGISTRY_COMMIT" ]; then
  echo "Updating Hyperlane registry to: $REGISTRY_COMMIT"
  OLDPWD=$(pwd)
  cd "$REGISTRY_URI"
  git fetch origin
  git checkout "$REGISTRY_COMMIT"

  # Only reset if it's a branch
  if git show-ref --verify --quiet "refs/remotes/origin/$REGISTRY_COMMIT"; then
    git reset --hard "origin/$REGISTRY_COMMIT"
  fi

  cd "$OLDPWD"
fi

# Execute the main container command
exec "$@"
