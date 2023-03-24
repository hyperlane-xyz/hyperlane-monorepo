#!/usr/bin/env bash

set -e

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
