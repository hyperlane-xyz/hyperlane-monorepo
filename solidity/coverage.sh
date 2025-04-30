#!/bin/bash

# exit on error
set -e

# exclude FastTokenRouter until https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2806 is resolved
forge coverage \
    --report lcov \
    --report summary \
    --no-match-coverage "(test|mock|node_modules|script|Fast)" \
    --no-match-test "Fork" \
    --ir-minimum # https://github.com/foundry-rs/foundry/issues/3357
