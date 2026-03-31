#!/bin/sh

# Cross-platform in-place sed
sedi() {
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# Update Solidity contract
sedi "s|string public constant PACKAGE_VERSION = \".*\";|string public constant PACKAGE_VERSION = \"$npm_package_version\";|" contracts/PackageVersioned.sol

# Update TypeScript file
sedi "s|export const CONTRACTS_PACKAGE_VERSION = '.*';|export const CONTRACTS_PACKAGE_VERSION = '$npm_package_version';|" core-utils/index.ts
