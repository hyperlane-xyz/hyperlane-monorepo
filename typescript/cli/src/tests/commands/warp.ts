import { $ } from 'zx';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../../utils/files.js';

import { getDeployedWarpAddress } from './helpers.js';

export const CHAIN_NAME = 'anvil1';
export const TEST_CONFIGS_PATH = './test-configs';
export const REGISTRY_PATH = `${TEST_CONFIGS_PATH}/anvil`;

export const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * Deploys the Hyperlane core contracts to the specified chain using the provided config.
 */
export async function hyperlaneCoreDeploy(coreInputPath: string) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane core deploy \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --config ${coreInputPath} \
        --chain ${CHAIN_NAME} \
        --key ${ANVIL_KEY} \
        --yes`;
}

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
export async function hyperlaneWarpDeploy(warpCoreInputPath: string) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp deploy \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --config ${warpCoreInputPath} \
        --key ${ANVIL_KEY} \
        --yes`;
}

/**
 * Applies updates to the Warp route config.
 */
export async function hyperlaneWarpApply(
  warpDeployPath: string,
  warpCorePath: string,
) {
  const logs =
    await $`yarn workspace @hyperlane-xyz/cli run hyperlane warp apply \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --config ${warpDeployPath} \
        --warp ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --yes`;
  console.log(logs);
}

/**
 * Reads the Warp route deployment config to specified output path.
 * @returns The Warp route deployment config.
 */
export async function readWarpConfig(
  warpCoreInputPath: string,
  warpDeployOutputPath: string,
): Promise<WarpRouteDeployConfig> {
  const warpAddress = getDeployedWarpAddress(warpCoreInputPath);

  await $`yarn workspace @hyperlane-xyz/cli run hyperlane warp read \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --address ${warpAddress} \
        --chain ${CHAIN_NAME} \
        --config ${warpDeployOutputPath}`;
  return readYamlOrJson(warpDeployOutputPath);
}
