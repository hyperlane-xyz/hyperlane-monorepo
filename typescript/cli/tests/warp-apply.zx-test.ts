import { Wallet, providers } from 'ethers';

import { HypNative__factory } from '@hyperlane-xyz/core';
import { assert, eqAddress } from '@hyperlane-xyz/utils';

import { getDeployedWarpAddress, updateWarpOwner } from './commands/helpers.js';
import {
  hyperlaneCoreDeploy,
  hyperlaneWarpApply,
  hyperlaneWarpDeploy,
} from './commands/warp.js';

/// To run: 1) start an anvil, 2) yarn run tsx tests/warp.zs-test.ts inside of cli/

const BURN_ADDRESS = '0x0000000000000000000000000000000000000001';
const LOCAL_ANVIL_HOST = 'http://localhost:8545';
const EXAMPLES_PATH = './examples';
const TEST_CONFIGS_PATH = './test-configs';
const REGISTRY_PATH = `${TEST_CONFIGS_PATH}/anvil`;
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
const WARP_CONFIG_PATH = `${EXAMPLES_PATH}/warp-route-deployment.yaml`;
const WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/ETH/anvil1-config.yaml`;

const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

async function checkWarpOwner() {
  const warpAddress = getDeployedWarpAddress(WARP_CORE_CONFIG_PATH);
  const provider = new providers.JsonRpcProvider(LOCAL_ANVIL_HOST);
  const signer = new Wallet(ANVIL_KEY, provider);
  const hypNative = HypNative__factory.connect(warpAddress!, signer);
  const owner = await hypNative.owner();
  assert(
    eqAddress(owner, BURN_ADDRESS),
    'Warp Apply did not set owner to address zero',
  );

  // TODO: Consider using logger
  console.log(`Successfully burned owner to ${BURN_ADDRESS}`);
}

await hyperlaneCoreDeploy(CORE_CONFIG_PATH);
await hyperlaneWarpDeploy(WARP_CONFIG_PATH);

const warpConfigPath = await updateWarpOwner(
  BURN_ADDRESS,
  WARP_CORE_CONFIG_PATH,
  `${EXAMPLES_PATH}/warp-route-deployment-2.yaml`,
);
await hyperlaneWarpApply(warpConfigPath, WARP_CORE_CONFIG_PATH);

await checkWarpOwner();
