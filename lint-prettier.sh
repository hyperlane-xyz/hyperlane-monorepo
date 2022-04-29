#!/bin/bash
set -exuo pipefail

yarn workspace @abacus-network/utils run prettier
yarn workspace @abacus-network/core run prettier
yarn workspace @abacus-network/hardhat run prettier
yarn workspace @abacus-network/app run prettier
yarn workspace @abacus-network/apps run prettier
yarn workspace @abacus-network/sdk run prettier
yarn workspace @abacus-network/contract-metrics run prettier
yarn workspace @abacus-network/deploy run prettier
yarn workspace @abacus-network/infra run prettier
