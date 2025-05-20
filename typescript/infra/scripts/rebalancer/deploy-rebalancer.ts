import { input } from '@inquirer/prompts';
import path from 'path';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/environment.js';
import { RebalancerHelmManager } from '../../src/rebalancer/helm.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { validateRegistryCommit } from '../../utils.js';
import {
  assertCorrectKubeContext,
  getArgs,
  getWarpRouteIdsInteractive,
  withMetrics,
  withWarpRouteId,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

function getRebalancerConfigPathPrefix(environment: DeployEnvironment) {
  return `config/environments/${environment}/rebalancer`;
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId, metrics } = await withMetrics(
    withWarpRouteId(getArgs()),
  ).parse();

  await assertCorrectKubeContext(getEnvironmentConfig(environment));

  let warpRouteIds;
  if (warpRouteId) {
    warpRouteIds = [warpRouteId];
  } else {
    warpRouteIds = await getWarpRouteIdsInteractive(environment);
  }

  const registryCommit = await input({
    message:
      'Enter the registry version to use (can be a commit, branch or tag):',
  });
  await validateRegistryCommit(registryCommit);

  rootLogger.info(
    `Deploying Rebalancer for Route ID: ${warpRouteIds.join(', ')}`,
  );

  const deployRebalancer = async (warpRouteId: string) => {
    // Build path for config file - relative for local checks
    const configFileName = `${warpRouteId}-config.yaml`;
    const relativeConfigPath = path.join(
      getRebalancerConfigPathPrefix(environment),
      configFileName,
    );

    const containerConfigPath = `/hyperlane-monorepo/typescript/infra/${relativeConfigPath}`;

    // Create the helm manager with container path for deployment
    const helmManager = new RebalancerHelmManager(
      warpRouteId,
      environment,
      registryCommit,
      containerConfigPath,
      'weighted',
      metrics,
    );

    await helmManager.runPreflightChecks(relativeConfigPath);

    await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade);
  };

  // TODO: Uninstall any stale rebalancer releases.

  for (const id of warpRouteIds) {
    rootLogger.info(`Deploying Rebalancer for Route ID: ${id}`);
    await deployRebalancer(id);
  }
}

main()
  .then(() => rootLogger.info('Deploy successful!'))
  .catch(rootLogger.error);
