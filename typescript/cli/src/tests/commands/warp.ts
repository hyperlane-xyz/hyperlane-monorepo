import { $, ProcessPromise } from 'zx';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../../utils/files.js';

import { ANVIL_KEY, REGISTRY_PATH, getDeployedWarpAddress } from './helpers.js';

$.verbose = true;

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
export function hyperlaneWarpInit(warpCorePath: string): ProcessPromise {
  // --overrides is " " to allow local testing to work
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp init \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --out ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;
}

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
export function hyperlaneWarpDeployRaw({
  warpCorePath,
  hypKey,
  skipConfirmationPrompts,
  privateKey,
}: {
  warpCorePath?: string;
  hypKey?: string;
  skipConfirmationPrompts?: boolean;
  privateKey?: string;
}): ProcessPromise {
  if (hypKey) {
    return $`HYP_KEY=${hypKey} yarn workspace @hyperlane-xyz/cli run hyperlane warp deploy \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        ${warpCorePath ? ['--config', warpCorePath] : []} \
        --verbosity debug \
        ${skipConfirmationPrompts ? '--yes' : ''}`;
  }

  if (privateKey) {
    return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp deploy \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        ${warpCorePath ? ['--config', warpCorePath] : []} \
        --key ${privateKey} \
        --verbosity debug \
        ${skipConfirmationPrompts ? '--yes' : ''}`;
  }

  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp deploy \
      --registry ${REGISTRY_PATH} \
      --overrides " " \
      ${warpCorePath ? ['--config', warpCorePath] : []} \
      --verbosity debug \
      ${skipConfirmationPrompts ? '--yes' : ''}`;
}

/**
 * Deploys the Warp route to the specified chain using the provided config.
 */
export function hyperlaneWarpDeploy(warpCorePath: string): ProcessPromise {
  return hyperlaneWarpDeployRaw({
    privateKey: ANVIL_KEY,
    warpCorePath: warpCorePath,
    skipConfirmationPrompts: true,
  });
}

/**
 * Applies updates to the Warp route config.
 */
export async function hyperlaneWarpApply(
  warpDeployPath: string,
  warpCorePath: string,
  strategyUrl = '',
) {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp apply \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --config ${warpDeployPath} \
        --warp ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --strategy ${strategyUrl} \
        --yes`;
}

export function hyperlaneWarpReadRaw({
  chain,
  warpAddress,
  outputPath,
  privateKey,
  symbol,
}: {
  chain?: string;
  symbol?: string;
  privateKey?: string;
  warpAddress?: string;
  outputPath?: string;
}): ProcessPromise {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp read \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        ${warpAddress ? ['--address', warpAddress] : []} \
        ${chain ? ['--chain', chain] : []} \
        ${symbol ? ['--symbol', symbol] : []} \
        ${privateKey ? ['--key', privateKey] : []} \
        --verbosity debug \
        ${outputPath ? ['--config', outputPath] : []}`;
}

export function hyperlaneWarpRead(
  chain: string,
  warpAddress: string,
  warpDeployPath: string,
): ProcessPromise {
  return hyperlaneWarpReadRaw({
    chain,
    warpAddress,
    outputPath: warpDeployPath,
    privateKey: ANVIL_KEY,
  });
}

export function hyperlaneWarpCheckRaw({
  warpDeployPath,
  symbol,
  privateKey,
  hypKey,
}: {
  symbol?: string;
  privateKey?: string;
  warpDeployPath?: string;
  hypKey?: string;
}): ProcessPromise {
  return $`${
    hypKey && !privateKey ? ['HYP_KEY=' + hypKey] : []
  } yarn workspace @hyperlane-xyz/cli run hyperlane warp check \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        ${symbol ? ['--symbol', symbol] : []} \
        ${privateKey && !hypKey ? ['--key', privateKey] : []} \
        --verbosity debug \
        ${warpDeployPath ? ['--config', warpDeployPath] : []}`;
}

export function hyperlaneWarpCheck(
  warpDeployPath: string,
  symbol: string,
): ProcessPromise {
  return hyperlaneWarpCheckRaw({
    warpDeployPath,
    privateKey: ANVIL_KEY,
    symbol,
  });
}

export function hyperlaneWarpSendRelay(
  origin: string,
  destination: string,
  warpCorePath: string,
  relay = true,
  value = 1,
): ProcessPromise {
  return $`yarn workspace @hyperlane-xyz/cli run hyperlane warp send \
        ${relay ? '--relay' : ''} \
        --registry ${REGISTRY_PATH} \
        --overrides " " \
        --origin ${origin} \
        --destination ${destination} \
        --warp ${warpCorePath} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes \
        --amount ${value}`;
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
): Promise<WarpRouteDeployConfig> {
  const warpAddress = getDeployedWarpAddress(chain, warpCorePath);
  await hyperlaneWarpRead(chain, warpAddress!, warpDeployPath);
  return readYamlOrJson(warpDeployPath);
}
