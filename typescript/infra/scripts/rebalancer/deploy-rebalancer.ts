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
import { validateRegistryCommit } from '../../src/utils/git.js';
import { HelmCommand } from '../../src/utils/helm.js';
import {
  assertCorrectKubeContext,
  getArgs,
  getWarpRouteIdsInteractive,
  withMetrics,
  withRegistryCommit,
  withWarpRouteId,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

function getRebalancerConfigPathPrefix(environment: DeployEnvironment) {
  return `config/environments/${environment}/rebalancer`;
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const {
    environment,
    warpRouteId,
    metrics,
    registryCommit: registryCommitArg,
  } = await withMetrics(withRegistryCommit(withWarpRouteId(getArgs()))).parse();

  await assertCorrectKubeContext(getEnvironmentConfig(environment));

  let warpRouteIds;
  if (warpRouteId) {
    warpRouteIds = [warpRouteId];
  } else {
    warpRouteIds = await getWarpRouteIdsInteractive(environment);
  }

  rootLogger.info(
    `Deploying Rebalancer for the following Route IDs:\n${warpRouteIds.map((id) => `  - ${id}`).join('\n')}`,
  );

  // Cache validated commits to avoid re-validating the same commit
  const validatedCommits = new Set<string>();

  const deployRebalancer = async (warpRouteId: string) => {
    // Get registry commit for this specific rebalancer
    let registryCommit: string;
    if (registryCommitArg) {
      registryCommit = registryCommitArg;
    } else {
      const defaultRegistryCommit =
        await RebalancerHelmManager.getDeployedRegistryCommit(
          warpRouteId,
          environment,
        );
      registryCommit = await input({
        message: `[${warpRouteId}] Enter registry version (commit, branch or tag):`,
        default: defaultRegistryCommit,
      });
    }

    if (!validatedCommits.has(registryCommit)) {
      await validateRegistryCommit(registryCommit);
      validatedCommits.add(registryCommit);
    }

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
