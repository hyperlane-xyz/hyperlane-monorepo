import chalk from 'chalk';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  addBridgeToChain,
  deriveBridgesConfig,
  getAndValidateBridgesToUpdate,
  getWarpConfigsAndArtifacts,
} from '../../src/xerc20/utils.js';
import {
  getArgs,
  withChains,
  withDryRun,
  withKnownWarpRouteIdRequired,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId, chains, dryRun } = await withChains(
    withKnownWarpRouteIdRequired(withDryRun(getArgs())),
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

  // if chains are provided, validate that they are in the warp config
  // throw an error if they are not
  const bridgesToUpdate = getAndValidateBridgesToUpdate(chains, bridgesConfig);

  const erroredChains: string[] = [];

  for (const bridgeConfig of bridgesToUpdate) {
    try {
      await addBridgeToChain({
        chain: bridgeConfig.chain,
        bridgeConfig,
        multiProtocolProvider,
        envMultiProvider,
        dryRun,
      });
    } catch (e) {
      rootLogger.error(
        chalk.red(
          `Error occurred while adding bridge to chain ${bridgeConfig.chain}: ${e}`,
        ),
      );
      erroredChains.push(bridgeConfig.chain);
    }
  }

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
