import { checkbox, input } from '@inquirer/prompts';
import path from 'path';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/environment.js';
import {
  RebalancerHelmManager,
  getDeployedRebalancerWarpRouteIds,
} from '../../src/rebalancer/helm.js';
import { REBALANCER_HELM_RELEASE_PREFIX } from '../../src/utils/consts.js';
import { validateRegistryCommit } from '../../src/utils/git.js';
import { HelmCommand } from '../../src/utils/helm.js';
import {
  assertCorrectKubeContext,
  filterOrphanedWarpRouteIds,
  getArgs,
  withMetrics,
  withRegistryCommit,
  withWarpRouteId,
  withYes,
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
    yes: skipConfirmation,
  } = await withYes(
    withMetrics(withRegistryCommit(withWarpRouteId(getArgs()))),
  ).parse();

  await assertCorrectKubeContext(getEnvironmentConfig(environment));

  let warpRouteIds: string[];
  if (warpRouteId) {
    warpRouteIds = [warpRouteId];
  } else {
    const deployedPods = await getDeployedRebalancerWarpRouteIds(
      environment,
      REBALANCER_HELM_RELEASE_PREFIX,
    );
    const deployedIds = deployedPods
      .map((p) => p.warpRouteId)
      .filter((id): id is string => !!id)
      .sort();

    if (deployedIds.length === 0) {
      rootLogger.error(
        'No deployed rebalancers found. Use --warp-route-id to deploy a new one.',
      );
      process.exit(1);
    }

    warpRouteIds = await checkbox({
      message: 'Select rebalancers to redeploy',
      choices: deployedIds.map((id) => ({ value: id })),
      pageSize: 30,
    });

    if (warpRouteIds.length === 0) {
      rootLogger.info('No rebalancers selected');
      process.exit(0);
    }
  }

  const { validIds: validWarpRouteIds, orphanedIds } =
    filterOrphanedWarpRouteIds(warpRouteIds);

  if (orphanedIds.length > 0) {
    rootLogger.warn(
      `Skipping ${orphanedIds.length} orphaned rebalancers (warp route no longer in registry):\n${orphanedIds.map((id) => `  - ${id}`).join('\n')}`,
    );
    rootLogger.warn('Run helm uninstall manually to remove these rebalancers');
  }

  if (validWarpRouteIds.length === 0) {
    rootLogger.info('No valid warp routes to deploy');
    process.exit(0);
  }

  rootLogger.info(
    `Deploying Rebalancer for the following Route IDs:\n${validWarpRouteIds.map((id) => `  - ${id}`).join('\n')}`,
  );

  // Cache validated commits to avoid re-validating the same commit
  const validatedCommits = new Set<string>();

  const deployRebalancer = async (warpRouteId: string) => {
    let registryCommit: string;
    if (registryCommitArg) {
      registryCommit = registryCommitArg;
    } else {
      const defaultRegistryCommit =
        await RebalancerHelmManager.getDeployedRegistryCommit(
          warpRouteId,
          environment,
        );

      if (skipConfirmation && defaultRegistryCommit) {
        registryCommit = defaultRegistryCommit;
      } else if (skipConfirmation) {
        throw new Error(
          `No existing registry commit found for ${warpRouteId}. Cannot use --yes without --registry-commit.`,
        );
      } else {
        registryCommit = await input({
          message: `[${warpRouteId}] Enter registry version (commit, branch or tag):`,
          default: defaultRegistryCommit,
        });
      }
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

  for (const id of validWarpRouteIds) {
    rootLogger.info(`Deploying Rebalancer for Route ID: ${id}`);
    await deployRebalancer(id);
  }
}

main()
  .then(() => rootLogger.info('Deploy successful!'))
  .catch(rootLogger.error);
