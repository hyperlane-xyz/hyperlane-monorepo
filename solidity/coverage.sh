#!/bin/bash

if [ -d "coverage" ]; then
    rm -rf coverage
fi

# generates lcov.info
forge coverage \
    --report lcov \
    --no-match-test testFork \
    --ir-minimum # https://github.com/foundry-rs/foundry/issues/3357

if ! command -v lcov &>/dev/null; then
    echo "lcov is not installed. Installing..."
    sudo apt-get install lcov
fi

lcov --version

# exclude FastTokenRouter until https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2806
EXCLUDE="*test* *mock* *node_modules* *FastHyp*"
lcov \
    --branch-coverage \
    --remove lcov.info $EXCLUDE \
    --output-file forge-pruned-lcov.info \

if [ "$CI" != "true" ]; then
    genhtml forge-pruned-lcov.info \
        --branch-coverage \
        --output-directory coverage
    open coverage/index.html
fi
