import { getArgs, withOutputFile } from '../../../../../scripts/agent-utils.js';
import {
  getEnvironmentConfig,
  getHyperlaneCore,
} from '../../../../../scripts/core-utils.js';
import { getRegistry } from '../../../../registry.js';
import { getWarpConfig, warpConfigGetterMap } from '../../../../warp.js';

async function main() {
  const { environment } = await withOutputFile(getArgs()).argv;
  const { multiProvider } = await getHyperlaneCore(environment);
  const envConfig = getEnvironmentConfig(environment);

  const warpIdsToCheck = Object.keys(warpConfigGetterMap);
  for (const warpRouteId of warpIdsToCheck) {
    console.log(`Generating Warp config for ${warpRouteId}`);

    const warpConfig = await getWarpConfig(
      multiProvider,
      envConfig,
      warpRouteId,
    );

    const registry = getRegistry();
    const configFileName = `${warpRouteId}.yaml`;
    registry.addWarpRouteConfig(warpConfig, configFileName);
    console.log(
      `Warp config successfully created at ${registry.getUri()}/${registry.getWarpRoutesConfigPath()}/${configFileName}`,
    );
  }
}

main().catch((err) => console.error('Error:', err));
