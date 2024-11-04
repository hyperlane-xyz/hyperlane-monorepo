import { writeFileSync } from 'fs';
import { stringify as yamlStringify } from 'yaml';

import { WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';

import { getEclipseEthereumUSDTWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getEclipseEthereumUSDTWarpConfig.js';

async function main() {
  // remove the argument in the function definition to call
  // const tokenConfig = await getEclipseEthereumUSDTWarpConfig();
  const parsed = WarpRouteDeployConfigSchema.safeParse('');

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
