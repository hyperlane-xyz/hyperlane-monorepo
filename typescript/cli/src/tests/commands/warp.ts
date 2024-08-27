import { $ } from 'zx';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../../utils/files.js';

import { ANVIL_KEY, REGISTRY_PATH, getDeployedWarpAddress } from './helpers.js';

$.verbose = true;

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
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp apply \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --config ${warpDeployPath} \
        --warp ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

export async function hyperlaneWarpRead(
  chain: string,
  warpAddress: string,
  warpDeployOutputPath: string,
) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp read \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --address ${warpAddress} \
        --chain ${chain} \
        --config ${warpDeployOutputPath}`;
}

/**
 * Reads the Warp route deployment config to specified output path.
 * @param warpCoreInputPath path to warp core
 * @param warpDeployOutputPath path to output the resulting read
 * @returns The Warp route deployment config.
 */
export async function readWarpConfig(
  chain: string,
  warpCoreInputPath: string,
  warpDeployOutputPath: string,
): Promise<WarpRouteDeployConfig> {
  const warpAddress = getDeployedWarpAddress(warpCoreInputPath);
  await hyperlaneWarpRead(chain, warpAddress!, warpDeployOutputPath);
  return readYamlOrJson(warpDeployOutputPath);
}
