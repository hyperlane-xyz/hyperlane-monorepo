import { writeFileSync } from 'fs';
import { stringify as yamlStringify } from 'yaml';

import { WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';

import { getEclipseEthereumUSDTWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getEclipseEthereumUSDTWarpConfig.js';

import { getRouterConfig } from './warp-routes/utils.js';

async function main() {
  const routerConfig = await getRouterConfig();
  const tokenConfig = await getEclipseEthereumUSDTWarpConfig(routerConfig);
  const parsed = WarpRouteDeployConfigSchema.safeParse(tokenConfig);

  if (!parsed.success) {
    console.dir(parsed.error.format(), { depth: null });
    return;
  }

  writeFileSync(
    'eclipse-usdt-warp-route-config.yaml',
    yamlStringify(parsed.data, null, 2),
  );
}

main().catch(console.error).then(console.log);
