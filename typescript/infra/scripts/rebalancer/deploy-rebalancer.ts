import { checkbox, input } from '@inquirer/prompts';
import path from 'path';
import { pino } from 'pino';

import {
  LogFormat,
  LogLevel,
  assert,
  configureRootLogger,
  rootLogger,
  setRootLogger,
} from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/deploy-environment.js';
import { readRebalancerConfig } from '../../src/rebalancer/config.js';
import {
  RebalancerHelmManager,
  getDeployedRebalancerWarpRouteIds,
} from '../../src/rebalancer/helm.js';
import { REBALANCER_HELM_RELEASE_PREFIX } from '../../src/utils/consts.js';
import { validateRegistryCommit } from '../../src/utils/git.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { getInfraPath } from '../../src/utils/utils.js';
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
    monitorOnly,
    render,
    registryCommit: registryCommitArg,
    yes: skipConfirmation,
  } = await withYes(
    withMetrics(withRegistryCommit(withWarpRouteId(getArgs())))
      .option('monitor-only', {
        type: 'boolean',
        default: false,
        describe:
          'Poll balances without constructing executors or submitting transactions',
      })
      .option('render', {
        type: 'boolean',
        default: false,
        describe:
          'Render the manifest locally without changing cluster resources',
      }),
  ).parse();

  if (render) {
    setRootLogger(pino({ level: 'info' }, process.stderr));
    assert(warpRouteId, '--render requires --warp-route-id');
  } else {
    await assertCorrectKubeContext(getEnvironmentConfig(environment));
  }

  let warpRouteIds: string[];
  if (warpRouteId) {
    warpRouteIds = [warpRouteId];
  } else {
    const deployedPods = await getDeployedRebalancerWarpRouteIds(
      environment,
      REBALANCER_HELM_RELEASE_PREFIX,
    );
    const deployedIds = [
      ...new Set(
        deployedPods
          .map((p) => p.warpRouteId)
          .filter((id): id is string => !!id),
      ),
    ].sort();

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

  // Explicit routes are validated against the selected registry revision in preflight.
  const { validIds: validWarpRouteIds, orphanedIds } = warpRouteId
    ? { validIds: warpRouteIds, orphanedIds: [] }
    : filterOrphanedWarpRouteIds(warpRouteIds);

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
    const relativeConfigPath = path.join(
      getRebalancerConfigPathPrefix(environment),
      `${warpRouteId}-config.yaml`,
    );
    const { deployment } = readRebalancerConfig(
      path.join(getInfraPath(), relativeConfigPath),
    );
    let registryCommit: string;
    const configuredCommit = registryCommitArg ?? deployment.registryCommit;
    if (configuredCommit) {
      registryCommit = configuredCommit;
    } else {
      assert(
        !render,
        '--render requires --registry-commit or deployment.registryCommit',
      );
      const defaultRegistryCommit =
        await RebalancerHelmManager.getDeployedRegistryCommit(
          warpRouteId,
          environment,
        );

      if (skipConfirmation) {
        registryCommit = defaultRegistryCommit ?? 'main';
      } else {
        registryCommit = await input({
          message: `[${warpRouteId}] Enter registry version (commit, branch or tag):`,
          default: defaultRegistryCommit,
        });
      }
    }

    if (!render && !validatedCommits.has(registryCommit)) {
      await validateRegistryCommit(registryCommit);
      validatedCommits.add(registryCommit);
    }

    const containerConfigPath = `/hyperlane-monorepo/typescript/infra/${relativeConfigPath}`;

    // Create the helm manager with container path for deployment
    const helmManager = new RebalancerHelmManager(
      warpRouteId,
      environment,
      registryCommit,
      containerConfigPath,
      'weighted',
      metrics,
      monitorOnly,
    );

    await helmManager.runPreflightChecks(relativeConfigPath);

    if (render) {
      process.stdout.write(await helmManager.renderManifest());
    } else {
      await helmManager.prepareForDeployment();
      await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade);
    }
  };

  // TODO: Uninstall any stale rebalancer releases.

  for (const id of validWarpRouteIds) {
    rootLogger.info(`Deploying Rebalancer for Route ID: ${id}`);
    await deployRebalancer(id);
  }
}

main().catch((error) => {
  rootLogger.error(error);
  process.exitCode = 1;
});
