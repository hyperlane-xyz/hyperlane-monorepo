import chalk from 'chalk';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';
import { getWarpConfig, warpConfigGetterMap } from '../../config/warp.js';
import { getArgs, withWarpRouteId } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

// Writes the warp configs into the Registry
async function main() {
  const { environment, warpRouteId } = await withWarpRouteId(getArgs()).argv;
  const { multiProvider } = await getHyperlaneCore(environment);
  const envConfig = getEnvironmentConfig(environment);
  const registry = getRegistry();

  const warpIdsToCheck = warpRouteId
    ? [warpRouteId]
    : Object.keys(warpConfigGetterMap);
  for (const warpRouteId of warpIdsToCheck) {
    console.log(`Generating Warp config for ${warpRouteId}`);

    const warpConfig = await getWarpConfig(
      multiProvider,
      envConfig,
      warpRouteId,
    );

    const registryConfig: WarpRouteDeployConfig = objMap(
      warpConfig,
      (_, config) => {
        const { mailbox: _mailbox, ...rest } = config;
        return rest;
      },
    );

    try {
      registry.addWarpRouteConfig(registryConfig, { warpRouteId });
    } catch (error) {
      console.error(
        chalk.red(`Failed to add warp route config for ${warpRouteId}:`, error),
      );
    }

    // TODO: Use registry.getWarpRoutesPath() to dynamically generate path by removing "protected"
    console.log(
      `Warp config successfully created at ${registry.getUri()}/deployments/warp_routes/${warpRouteId}-deploy.yaml`,
    );
  }
}

main().catch((err) => console.error('Error:', err));
