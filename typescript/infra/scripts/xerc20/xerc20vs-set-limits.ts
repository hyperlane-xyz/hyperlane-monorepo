import chalk from 'chalk';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  deriveBridgesConfig,
  getWarpConfigsAndArtifacts,
  updateChainLimits,
} from '../../src/xerc20/utils.js';
import { getArgs, withWarpRouteIdRequired } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId } = await withWarpRouteIdRequired(getArgs())
    .argv;

  const { warpDeployConfig, warpCoreConfig, warpAddresses } =
    getWarpConfigsAndArtifacts(warpRouteId);

  const envConfig = getEnvironmentConfig(environment);
  const multiProtocolProvider = await envConfig.getMultiProtocolProvider();
  const envMultiProvider = await envConfig.getMultiProvider();
  const bridgesConfig = await deriveBridgesConfig(
    warpDeployConfig,
    warpCoreConfig,
    warpAddresses,
    envMultiProvider,
  );

  const results = await Promise.allSettled(
    Object.entries(bridgesConfig).map(async ([chain, bridgeConfig]) => {
      return updateChainLimits({
        chain,
        bridgeConfig,
        multiProtocolProvider,
        envMultiProvider,
      });
    }),
  );

  const erroredChains = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    .map((result) => result.reason.chain);

  if (erroredChains.length > 0) {
    rootLogger.error(
      chalk.red(
        `Errors occurred on the following chains: ${erroredChains.join(', ')}`,
      ),
    );
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
