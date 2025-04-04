import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { getRegistry } from '../../config/registry.js';
import { getWarpConfig, warpConfigGetterMap } from '../../config/warp.js';
import { getArgs, withOutputFile } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

// Writes the warp configs into the Registry
async function main() {
  const { environment } = await withOutputFile(getArgs()).argv;
  const { multiProvider } = await getHyperlaneCore(environment);
  const envConfig = getEnvironmentConfig(environment);
  const registry = getRegistry();

  const warpIdsToCheck = Object.keys(warpConfigGetterMap);
  for (const warpRouteId of warpIdsToCheck) {
    console.log(`Generating Warp config for ${warpRouteId}`);

    const warpConfigs = await getWarpConfig(
      multiProvider,
      envConfig,
      warpRouteId,
    );

    const registryConfig: WarpRouteDeployConfig = Object.fromEntries(
      Object.entries(warpConfigs).map(([chain, config]) => {
        const { mailbox: _mailbox, ...rest } = config;
        return [chain, { ...rest }];
      }),
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
