import chalk from 'chalk';

import { ChainMap } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { readYaml } from '../../src/utils/utils.js';
import {
  BridgeConfig,
  XERC20_BRIDGES_CONFIG_PATH,
  updateChainLimits,
} from '../../src/xerc20/utils.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment } = await getArgs().argv;

  const bridgesConfig = readYaml<ChainMap<BridgeConfig>>(
    XERC20_BRIDGES_CONFIG_PATH,
  );
  if (!bridgesConfig) {
    throw new Error(
      `Could not read or parse config at path: ${XERC20_BRIDGES_CONFIG_PATH}`,
    );
  }

  const envConfig = getEnvironmentConfig(environment);
  const multiProtocolProvider = await envConfig.getMultiProtocolProvider();
  const envMultiProvider = await envConfig.getMultiProvider();

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
