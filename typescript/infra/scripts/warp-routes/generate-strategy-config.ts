import prompts from 'prompts';

import {
  LogFormat,
  LogLevel,
  assert,
  configureRootLogger,
} from '@hyperlane-xyz/utils';

import { strategyConfigGetterMap } from '../../config/warp.js';
import { writeYamlAtPath } from '../../src/utils/utils.js';
import {
  getArgs,
  withKnownWarpRouteId,
  withOutputFile,
} from '../agent-utils.js';

// Writes the strategy config to disk
async function main() {
  const logger = configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { warpRouteId, outFile } = await withOutputFile(
    withKnownWarpRouteId(getArgs()),
  ).argv;
  assert(warpRouteId, 'warpRouteId not provided');

  const strategy = strategyConfigGetterMap[warpRouteId]();
  assert(strategy, `Strategy not found by warpId ${strategy}`);

  logger.info(`Strategy Created`, strategy);

  if (outFile) {
    // JSON strategies may contain private keys
    const { value: confirmed } = await prompts({
      type: 'confirm',
      name: 'value',
      message: `WARNING: Sensitive strategies may be inadvertently checked in. Are you sure you want to output this to disk?`,
      initial: false,
    });
    if (!confirmed) {
      process.exit(0);
    }
    const configFileName = `${warpRouteId}-strategy.yaml`;
    const outputFilePath = `${outFile}/${configFileName}`;
    writeYamlAtPath(outputFilePath, strategy);
    logger.info(`Strategy successfully created at`, outputFilePath);
  }
}

main().catch((err) => console.error('Error:', err));
