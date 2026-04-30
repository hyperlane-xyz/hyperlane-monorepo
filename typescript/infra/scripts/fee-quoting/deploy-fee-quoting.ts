import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DockerImageRepos, mainnetDockerTags } from '../../config/docker.js';
import { FeeQuotingHelmManager } from '../../src/fee-quoting/helm.js';
import { verifyImagesAndConfirm } from '../../src/utils/attestation.js';
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

  await verifyImagesAndConfirm([
    {
      component: 'fee-quoting',
      image: DockerImageRepos.NODE_SERVICES,
      tag: mainnetDockerTags.feeQuoting,
    },
  ]);

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
