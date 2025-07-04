import { stringify as yamlStringify } from 'yaml';

import { WarpRouteDeployConfigSchema } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { getWarpConfig } from '../../config/warp.js';
import { writeYamlAtPath } from '../../src/utils/utils.js';
import {
  getArgs,
  withKnownWarpRouteIdRequired,
  withOutputFile,
} from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

async function main() {
  const { warpRouteId, environment, outFile } = await withOutputFile(
    withKnownWarpRouteIdRequired(getArgs()),
  ).argv;

  const { multiProvider } = await getHyperlaneCore(environment);
  const envConfig = getEnvironmentConfig(environment);

  const warpConfig = await getWarpConfig(multiProvider, envConfig, warpRouteId);
  const parsed = WarpRouteDeployConfigSchema.safeParse(warpConfig);

  if (!parsed.success) {
    rootLogger.error('Error parsing warp config:');
    console.dir(warpConfig, { depth: null });
    console.dir(parsed.error.format(), { depth: null });
    return;
  }

  rootLogger.info('Warp config:');
  rootLogger.info(yamlStringify(parsed.data, null, 2));

  if (outFile) {
    rootLogger.info(`Writing config to ${outFile}`);
    writeYamlAtPath(outFile, parsed.data);
  }
}

main().catch((err) => rootLogger.error('Error:', err));
