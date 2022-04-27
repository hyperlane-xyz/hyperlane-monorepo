#!/bin/bash
set -exuo pipefail

yarn workspace @abacus-network/utils run build
yarn workspace @abacus-network/core run build
yarn workspace @abacus-network/hardhat run build
yarn workspace @abacus-network/app run build
yarn workspace @abacus-network/apps run build
yarn workspace @abacus-network/sdk run build
yarn workspace @abacus-network/contract-metrics run build
yarn workspace @abacus-network/deploy run build
yarn workspace @abacus-network/infra run build