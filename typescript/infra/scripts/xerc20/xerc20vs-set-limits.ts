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
import {
  getArgs,
  withDryRun,
  withWarpRouteIdRequired,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId, dryRun } = await withWarpRouteIdRequired(
    withDryRun(getArgs()),
  ).argv;

  const { warpDeployConfig, warpCoreConfig } =
    getWarpConfigsAndArtifacts(warpRouteId);

  const envConfig = getEnvironmentConfig(environment);
  const multiProtocolProvider = await envConfig.getMultiProtocolProvider();
  const envMultiProvider = await envConfig.getMultiProvider();
  const bridgesConfig = await deriveBridgesConfig(
    warpDeployConfig,
    warpCoreConfig,
    envMultiProvider,
  );

  const results = await Promise.allSettled(
    Object.entries(bridgesConfig).map(async ([_, bridgeConfig]) => {
      return updateChainLimits({
        chain: bridgeConfig.chain,
        bridgeConfig,
        multiProtocolProvider,
        envMultiProvider,
        dryRun,
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
