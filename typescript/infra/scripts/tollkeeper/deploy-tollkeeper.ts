import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { TollkeeperHelmManager } from '../../src/tollkeeper/helm.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { assertCorrectKubeContext, getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// Managed chains — must match values-{env}.yaml
const MANAGED_CHAINS = [
  'ethereum',
  'arbitrum',
  'optimism',
  'base',
  'polygon',
  'bsc',
  'avalanche',
  'eclipsemainnet',
];

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { environment } = await getArgs().parse();

  await assertCorrectKubeContext(getEnvironmentConfig(environment));

  rootLogger.info(`Deploying Tollkeeper to ${environment}`);

  const helmManager = new TollkeeperHelmManager(
    environment,
    MANAGED_CHAINS,
  );

  await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade);

  rootLogger.info('Tollkeeper deploy complete');
}

main().catch((err) => {
  rootLogger.error(err);
  process.exit(1);
});
