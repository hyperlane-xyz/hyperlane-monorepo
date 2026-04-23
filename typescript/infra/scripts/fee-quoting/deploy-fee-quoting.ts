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

  // Note: FEE_QUOTING image is not built by a workflow in this repo and
  // therefore has no attestation to verify. Add attestation verify here
  // once the image is built + signed by CI.

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
