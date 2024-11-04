import { writeFileSync } from 'fs';
import { stringify as yamlStringify } from 'yaml';

import { WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';

import { getEclipseEthereumWBTCWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getEclipseEthereumWBTCWarpConfig.js';

async function main() {
  // remove the argument in the function definition to call
  // const tokenConfig = await getEclipseEthereumWBTCWarpConfig();
  const parsed = WarpRouteDeployConfigSchema.safeParse('');

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
