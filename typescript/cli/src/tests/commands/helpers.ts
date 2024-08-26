import { WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';

import { CHAIN_NAME, readWarpConfig } from './warp.js';

/**
 * Retrieves the deployed Warp address from the Warp core config.
 * @param warpCorePath - The file path to the Warp core config.
 * @returns The deployed Warp address.
 */
export function getDeployedWarpAddress(warpCorePath: string) {
  const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCorePath);
  return warpCoreConfig.tokens[0].addressOrDenom;
}

/**
 * Updates the owner of the Warp route deployment config, and then output to a file
 * @returns The file path to the updated Warp route deployment config.
 */
export async function updateWarpOwner(
  owner: Address,
  warpCoreInputPath: string,
  warpDeployOutputPath: string,
): Promise<string> {
  const warpDeployConfig = await readWarpConfig(
    warpCoreInputPath,
    warpDeployOutputPath,
  );
  warpDeployConfig[CHAIN_NAME].owner = owner;
  writeYamlOrJson(warpDeployOutputPath, warpDeployConfig);

  return warpDeployOutputPath;
}
