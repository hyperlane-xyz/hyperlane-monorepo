import { writeFileSync } from 'fs';
import { stringify as yamlStringify } from 'yaml';

import { WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';

import { getEclipseEthereumWBTCWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getEclipseEthereumWBTCWarpConfig.js';

import { getRouterConfig } from './warp-routes/utils.js';

async function main() {
  let routerConfig = await getRouterConfig();
  const tokenConfig = await getEclipseEthereumWBTCWarpConfig(routerConfig);
  const parsed = WarpRouteDeployConfigSchema.safeParse(tokenConfig);

  if (!parsed.success) {
    console.dir(parsed.error.format(), { depth: null });
    return;
  }

  writeFileSync(
    'eclipse-wbtc-warp-route-config.yaml',
    yamlStringify(parsed.data, null, 2),
  );
}

main().catch(console.error).then(console.log);
