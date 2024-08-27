import { ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenRouterConfig, WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../context/context.js';
import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';

import { hyperlaneCoreDeploy } from './core.js';
import { hyperlaneWarpApply, readWarpConfig } from './warp.js';

export const TEST_CONFIGS_PATH = './test-configs';
export const REGISTRY_PATH = `${TEST_CONFIGS_PATH}/anvil`;

export const ANVIL_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * Retrieves the deployed Warp address from the Warp core config.
 */
export function getDeployedWarpAddress(warpCorePath: string) {
  const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCorePath);
  return warpCoreConfig.tokens[0].addressOrDenom;
}

/**
 * Updates the owner of the Warp route deployment config, and then output to a file
 */
export async function updateWarpOwnerConfig(
  chain: string,
  owner: Address,
  warpCoreInputPath: string,
  warpDeployOutputPath: string,
): Promise<string> {
  const warpDeployConfig = await readWarpConfig(
    chain,
    warpCoreInputPath,
    warpDeployOutputPath,
  );
  warpDeployConfig[chain].owner = owner;
  writeYamlOrJson(warpDeployOutputPath, warpDeployConfig);

  return warpDeployOutputPath;
}

/**
 * Updates the Warp route deployment configuration with a new owner, and then applies the changes.
 */
export async function updateOwner(
  warpConfigPath: string,
  warpCoreConfigPath: string,
  owner: Address,
  chain: string,
) {
  await updateWarpOwnerConfig(chain, owner, warpCoreConfigPath, warpConfigPath);
  return hyperlaneWarpApply(warpConfigPath, warpCoreConfigPath);
}

/**
 * Extends the Warp route deployment with a new warp config
 */
export async function extendWarpConfig(
  chain: string,
  chainToExtend: string,
  extendedConfig: TokenRouterConfig,
  warpCoreInputPath: string,
  warpDeployOutputPath: string,
): Promise<string> {
  const warpDeployConfig = await readWarpConfig(
    chain,
    warpCoreInputPath,
    warpDeployOutputPath,
  );
  warpDeployConfig[chainToExtend] = extendedConfig;
  writeYamlOrJson(warpDeployOutputPath, warpDeployConfig);
  await hyperlaneWarpApply(warpDeployOutputPath, warpCoreInputPath);

  return warpDeployOutputPath;
}

/**
 * Deploys new core contracts on the specified chain if it doesn't already exist, and returns the chain addresses.
 */
export async function deployOrUseExistingCore(
  chain: string,
  coreInputPath: string,
) {
  const addresses = (await getRegistry(REGISTRY_PATH, '').getChainAddresses(
    chain,
  )) as ChainAddresses;
  if (!addresses) {
    await hyperlaneCoreDeploy(chain, coreInputPath);
    return getRegistry(REGISTRY_PATH, '').getChainAddresses(
      chain,
    ) as ChainAddresses;
  }

  return addresses;
}
