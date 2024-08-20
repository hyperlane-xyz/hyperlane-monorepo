import { writeFileSync } from 'fs';
import { stringify as yamlStringify } from 'yaml';

import { WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';

import { getRenzoEZETHWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getRenzoEZETHWarpConifg.js';

async function main() {
  const tokenConfig = await getRenzoEZETHWarpConfig({});
  const parsed = WarpRouteDeployConfigSchema.safeParse(tokenConfig);

  if (!parsed.success) {
    console.dir(parsed.error.format(), { depth: null });
    return;
  }

  writeFileSync(
    'renzo-warp-route-config.yaml',
    yamlStringify(parsed.data, null, 2),
  );
}

main().catch(console.error).then(console.log);
