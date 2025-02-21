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
  getWarpConfigsAndArtifacts,
} from '../../src/xerc20/utils.js';
import {
  getArgs,
  withChains,
  withDryRun,
  withWarpRouteIdRequired,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId, chains, dryRun } = await withChains(
    withWarpRouteIdRequired(withDryRun(getArgs())),
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

  const configChains = Object.keys(bridgesConfig);
  if (chains) {
    const missingChains = chains.filter(
      (chain) => !configChains.includes(chain),
    );
    if (missingChains.length > 0) {
      throw new Error(
        `The following chains are not in the provided warp config: ${missingChains.join(
          ', ',
        )}`,
      );
    }
  }

  const erroredChains: string[] = [];

  for (const [_, bridgeConfig] of Object.entries(bridgesConfig)) {
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
