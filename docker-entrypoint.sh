#!/bin/sh
set -e

# Set default registry URI, same as Dockerfile
REGISTRY_URI="/hyperlane-registry"

echo "REGISTRY_COMMIT: $REGISTRY_COMMIT"
echo "REGISTRY_URI: $REGISTRY_URI"
echo "Current commit: $(git -C "$REGISTRY_URI" rev-parse HEAD)"

# Only update registry if REGISTRY_COMMIT is set
if [ -n "$REGISTRY_COMMIT" ]; then
  echo "Updating Hyperlane registry to: $REGISTRY_COMMIT"
  OLDPWD=$(pwd)
  cd "$REGISTRY_URI"
  git fetch origin "$REGISTRY_COMMIT"
  git checkout "$REGISTRY_COMMIT"

  # Only reset if it's a branch
  if git show-ref --verify --quiet "refs/remotes/origin/$REGISTRY_COMMIT"; then
    git reset --hard "origin/$REGISTRY_COMMIT"
  fi

  cd "$OLDPWD"
fi

# If INSTALL_GCP_LOGGER_CLI is true, install the package
if [ "$INSTALL_GCP_LOGGER_CLI" = "true" ]; then
  echo "INSTALL_GCP_LOGGER_CLI is set, installing @google-cloud/pino-logging-gcp-config for CLI..."
  # We install in the CLI directory context for yarn workspaces
  yarn workspace @hyperlane-xyz/cli add @google-cloud/pino-logging-gcp-config
  echo "Installation complete."
fi

# Execute the main container command
exec "$@"
