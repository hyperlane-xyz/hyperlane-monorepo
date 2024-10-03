import { writeFileSync } from 'fs';
import { stringify as yamlStringify } from 'yaml';

import { WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';

import { getRenzoPZETHWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getRenzoPZETHWarpConfig.js';

async function main() {
  const tokenConfig = await getRenzoPZETHWarpConfig();
  const parsed = WarpRouteDeployConfigSchema.safeParse(tokenConfig);

  if (!parsed.success) {
    console.dir(parsed.error.format(), { depth: null });
    return;
  }

  writeFileSync(
    'renzo-pzeth-warp-route-config.yaml',
    yamlStringify(parsed.data, null, 2),
  );
}

main().catch(console.error).then(console.log);
