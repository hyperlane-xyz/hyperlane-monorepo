#!/bin/sh
set -e

# Set default registry URI, same as Dockerfile
REGISTRY_URI="/hyperlane-registry"

echo "REGISTRY_COMMIT: $REGISTRY_COMMIT"
echo "REGISTRY_URI: $REGISTRY_URI"
echo "REGISTRY_FALLBACK_ENABLED: $REGISTRY_FALLBACK_ENABLED"
echo "Current commit: $(git -C "$REGISTRY_URI" rev-parse HEAD)"

# Only update registry if REGISTRY_COMMIT is set
if [ -n "$REGISTRY_COMMIT" ]; then
  echo "Updating Hyperlane registry to: $REGISTRY_COMMIT"
  OLDPWD=$(pwd)
  cd "$REGISTRY_URI"
  
  # Try to fetch and checkout the specified commit
  if git fetch origin "$REGISTRY_COMMIT" 2>/dev/null && git checkout "$REGISTRY_COMMIT" 2>/dev/null; then
    echo "Successfully checked out: $REGISTRY_COMMIT"
    
    # Only reset if it's a branch
    if git show-ref --verify --quiet "refs/remotes/origin/$REGISTRY_COMMIT"; then
      git reset --hard "origin/$REGISTRY_COMMIT"
    fi
  else
    echo "Failed to checkout: $REGISTRY_COMMIT"
    
    # Check if fallback is enabled
    if [ "$REGISTRY_FALLBACK_ENABLED" = "true" ]; then
      echo "REGISTRY_FALLBACK_ENABLED is enabled, falling back to main branch"
      if git fetch origin main 2>/dev/null && git checkout main 2>/dev/null; then
        git reset --hard origin/main
        echo "Successfully fell back to main branch"
      else
        echo "Error: Failed to fallback to main branch"
        exit 1
      fi
    else
      echo "Error: Commit not found and REGISTRY_FALLBACK_ENABLED is not enabled"
      exit 1
    fi
  fi

  cd "$OLDPWD"
fi

# Execute the main container command
exec "$@"
