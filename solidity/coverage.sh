#!/bin/bash

# exit on error
set -e

forge coverage \
    --report lcov \
    --report summary \
    --no-match-coverage "(test|mock|node_modules|script|Fast|TypedMemView)" \
    --no-match-test "Fork" \
    --ir-minimum # https://github.com/foundry-rs/foundry/issues/3357
