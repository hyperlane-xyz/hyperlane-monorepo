import chalk from 'chalk';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getRegistry, getWarpAddresses } from '../../config/registry.js';
import {
  addBridgeToChain,
  deriveBridgesConfig,
} from '../../src/xerc20/utils.js';
import { getArgs, withWarpRouteIdRequired } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId } = await withWarpRouteIdRequired(getArgs())
    .argv;

  const registry = getRegistry();
  const warpDeployConfig = registry.getWarpDeployConfig(warpRouteId);
  const warpCoreConfig = registry.getWarpRoute(warpRouteId);
  if (!warpDeployConfig) {
    throw new Error(`Warp deploy config for route ID ${warpRouteId} not found`);
  }
  if (!warpCoreConfig) {
    throw new Error(`Warp core config for route ID ${warpRouteId} not found`);
  }
  const warpAddresses = getWarpAddresses(warpRouteId);

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
      return addBridgeToChain({
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
