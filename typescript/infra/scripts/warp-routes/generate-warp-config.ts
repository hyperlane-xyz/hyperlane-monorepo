import { stringify as yamlStringify } from 'yaml';

import { WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';

import { getWarpConfig } from '../../config/warp.js';
import { writeYamlAtPath } from '../../src/utils/utils.js';
import { getArgs, withWarpRouteIdRequired } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

async function main() {
  const { warpRouteId, environment, outFile } = await withWarpRouteIdRequired(
    getArgs(),
  )
    .string('outFile')
    .describe('outFile', 'The file to write the config to').argv;

  const { multiProvider } = await getHyperlaneCore(environment);
  const envConfig = getEnvironmentConfig(environment);

  const warpConfig = await getWarpConfig(multiProvider, envConfig, warpRouteId);
  const parsed = WarpRouteDeployConfigSchema.safeParse(warpConfig);

  if (!parsed.success) {
    console.dir(parsed.error.format(), { depth: null });
    return;
  }

  console.log('Warp config:');
  console.log(yamlStringify(parsed.data, null, 2));

  if (outFile) {
    console.log(`Writing config to ${outFile}`);
    writeYamlAtPath(outFile, parsed.data);
  }
}

main().catch((err) => console.error('Error:', err));
