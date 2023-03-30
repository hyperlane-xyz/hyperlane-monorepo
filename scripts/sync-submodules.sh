#!/usr/bin/env bash

# This is designed to synchronize the typescript submodules with the committed submodule version and
# then clean and build the typescript codebase. This will not update the submodules.

set -e

DIRNAME=$(basename "$PWD")
if [[ "$DIRNAME" != "hyperlane-monorepo" ]]; then
  echo "Must be run from the root of the monorepo"
  exit 1
fi

DIRS=$(git submodule status | grep -oE "typescript/[a-zA-Z0-9_-]+")
for DIR in $DIRS ; do
    echo "Removing '$DIR'"
    rm -rf "$DIR"
done

git submodule init
git submodule update

for DIR in $DIRS ; do
    echo "Cleaning '$DIR'"
    pushd "$DIR" || continue
    rm -rf yarn.lock node_modules
    popd || exit 1
done

yarn clean
yarn install
yarn build
