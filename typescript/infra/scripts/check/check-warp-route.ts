import chalk from 'chalk';
import { stringify as yamlStringify } from 'yaml';

import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  type WarpCoreConfig,
  type WarpRouteCheckResult,
  type WarpRouteDeployConfigMailboxRequired,
  checkWarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { assert, objFilter } from '@hyperlane-xyz/utils';

import { getWarpDeployConfigFromMergedRegistry } from '../../config/warp.js';
import { type EnvironmentConfig } from '../../src/config/environment.js';

export async function runWarpRouteCheckFromRegistry({
  multiProvider,
  warpRouteId,
  registryUris,
  chains,
  warpCoreConfig,
  warpDeployConfig,
}: {
  chains?: string[];
  multiProvider: Awaited<ReturnType<EnvironmentConfig['getMultiProvider']>>;
  registryUris: string[];
  warpCoreConfig?: WarpCoreConfig;
  warpDeployConfig?: WarpRouteDeployConfigMailboxRequired;
  warpRouteId: string;
}): Promise<WarpRouteCheckResult> {
  const loadedConfigs =
    warpCoreConfig && warpDeployConfig
      ? { warpCoreConfig, warpDeployConfig }
      : await loadWarpConfigsFromRegistry({ registryUris, warpRouteId });

  const filteredConfigs = filterWarpConfigsByChains({
    chains,
    warpCoreConfig: loadedConfigs.warpCoreConfig,
    warpDeployConfig: loadedConfigs.warpDeployConfig,
  });

  return checkWarpRouteDeployConfig({
    multiProvider,
    warpCoreConfig: filteredConfigs.warpCoreConfig,
    warpDeployConfig: filteredConfigs.warpDeployConfig,
  });
}

export function logWarpRouteCheckResult(result: WarpRouteCheckResult) {
  if (Object.keys(result.diff).length > 0) {
    console.log(chalk.yellow(yamlStringify(result.diff, null, 2)));
  }

  if (result.scaleViolations.length > 0) {
    console.log(
      chalk.red('Found invalid or missing scale for inconsistent decimals'),
    );
  }

  if (result.violations.length > 0) {
    console.table(result.violations, [
      'chain',
      'name',
      'type',
      'actual',
      'expected',
    ]);
  }
}

async function loadWarpConfigsFromRegistry({
  registryUris,
  warpRouteId,
}: {
  registryUris: string[];
  warpRouteId: string;
}): Promise<{
  warpCoreConfig: WarpCoreConfig;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}> {
  const registry = getRegistry({
    registryUris,
    enableProxy: true,
  });

  const [warpCoreConfig, warpDeployConfig] = await Promise.all([
    registry.getWarpRoute(warpRouteId),
    getWarpDeployConfigFromMergedRegistry(warpRouteId, registryUris),
  ]);

  assert(warpCoreConfig, `Warp route config not found for ${warpRouteId}`);
  assert(
    warpDeployConfig,
    `Warp route deploy config not found for ${warpRouteId}`,
  );

  return { warpCoreConfig, warpDeployConfig };
}

function filterWarpConfigsByChains({
  chains,
  warpCoreConfig,
  warpDeployConfig,
}: {
  chains?: string[];
  warpCoreConfig: WarpCoreConfig;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}) {
  if (!chains?.length) {
    return { warpCoreConfig, warpDeployConfig };
  }

  const requestedChains = new Set(chains);

  const filteredWarpCoreConfig = {
    ...warpCoreConfig,
    tokens: warpCoreConfig.tokens.filter((token) =>
      requestedChains.has(token.chainName),
    ),
  };
  const filteredWarpDeployConfig = objFilter(
    warpDeployConfig,
    (chain, config): config is WarpRouteDeployConfigMailboxRequired[string] =>
      requestedChains.has(chain),
  );

  assert(
    filteredWarpCoreConfig.tokens.length > 0,
    `None of the requested chains are present in the warp core config: ${chains.join(', ')}`,
  );
  assert(
    Object.keys(filteredWarpDeployConfig).length > 0,
    `None of the requested chains are present in the warp deploy config: ${chains.join(', ')}`,
  );

  return {
    warpCoreConfig: filteredWarpCoreConfig,
    warpDeployConfig: filteredWarpDeployConfig,
  };
}
