import { $ } from 'zx';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../../utils/files.js';

import { ANVIL_KEY, REGISTRY_PATH, getDeployedWarpAddress } from './helpers.js';

$.verbose = true;

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
export async function hyperlaneWarpDeploy(
  warpCorePath: string,
  key?: string,
  registryPath?: string,
) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp deploy \
        --registry ${registryPath ?? REGISTRY_PATH} \
        --overrides " " \
        --config ${warpCorePath} \
        --key ${key ?? ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

/**
 * Applies updates to the Warp route config.
 */
export async function hyperlaneWarpApply(
  warpDeployPath: string,
  warpCorePath: string,
  strategyUrl = '',
  key?: string,
  registryPath?: string,
) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp apply \
        --registry ${registryPath ?? REGISTRY_PATH} \
        --overrides " " \
        --config ${warpDeployPath} \
        --warp ${warpCorePath} \
        --key ${key ?? ANVIL_KEY} \
        --verbosity debug \
        --strategy ${strategyUrl} \
        --yes`;
}

export async function hyperlaneWarpRead(
  chain: string,
  warpAddress: string,
  warpDeployPath: string,
  key?: string,
  registryPath?: string,
) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp read \
        --registry ${registryPath ?? REGISTRY_PATH} \
        --overrides " " \
        --address ${warpAddress} \
        --chain ${chain} \
        --key ${key ?? ANVIL_KEY} \
        --verbosity debug \
        --config ${warpDeployPath}`;
}

export async function hyperlaneWarpSendRelay(
  origin: string,
  destination: string,
  warpCorePath: string,
  relay = true,
) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp send \
        ${relay ? '--relay' : ''} \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --origin ${origin} \
        --destination ${destination} \
        --warp ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

/**
 * Reads the Warp route deployment config to specified output path.
 * @param warpCorePath path to warp core
 * @param warpDeployPath path to output the resulting read
 * @returns The Warp route deployment config.
 */
export async function readWarpConfig(
  chain: string,
  warpCorePath: string,
  warpDeployPath: string,
  key?: string,
  registryPath?: string,
): Promise<WarpRouteDeployConfig> {
  const warpAddress = getDeployedWarpAddress(chain, warpCorePath);
  await hyperlaneWarpRead(
    chain,
    warpAddress!,
    warpDeployPath,
    key,
    registryPath,
  );
  return readYamlOrJson(warpDeployPath);
}
