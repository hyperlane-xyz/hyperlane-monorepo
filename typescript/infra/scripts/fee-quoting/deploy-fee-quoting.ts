import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { FeeQuotingHelmManager } from '../../src/fee-quoting/helm.js';
import { HelmCommand } from '../../src/utils/helm.js';
import {
  assertCorrectKubeContext,
  getArgs,
  withRegistryCommit,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { environment, registryCommit } =
    await withRegistryCommit(getArgs()).parse();

  await assertCorrectKubeContext(getEnvironmentConfig(environment));

  const helmManager = new FeeQuotingHelmManager(
    environment,
    registryCommit ?? 'main',
  );

  rootLogger.info(`Deploying fee-quoting service to ${environment}`);
  await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade);
}

main()
  .then(() => rootLogger.info('Deploy successful!'))
  .catch(rootLogger.error);
