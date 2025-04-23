import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';
import { getWarpConfig, warpConfigGetterMap } from '../../config/warp.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

// Writes the warp configs into the Registry
async function main() {
  const { environment } = await getArgs().argv;
  const { multiProvider } = await getHyperlaneCore(environment);
  const envConfig = getEnvironmentConfig(environment);
  const registry = getRegistry();

  const warpIdsToCheck = Object.keys(warpConfigGetterMap);
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

    const configFileName = `${warpRouteId}-deploy.yaml`;
    registry.addWarpRouteConfig(registryConfig, configFileName);

    // TODO: Use registry.getWarpRoutesPath() to dynamically generate path by removing "protected"
    console.log(
      `Warp config successfully created at ${registry.getUri()}/deployments/warp_routes/${configFileName}`,
    );
  }
}

main().catch((err) => console.error('Error:', err));
