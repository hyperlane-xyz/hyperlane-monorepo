import { checkbox, input } from '@inquirer/prompts';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
  sleep,
} from '@hyperlane-xyz/utils';

import {
  getRebalancerFleet,
  rebalancerFleets,
} from '../../config/environments/mainnet3/rebalancer/fleets.js';
import { DeployEnvironment } from '../../src/config/deploy-environment.js';
import {
  RebalancerFleetHelmManager,
  RebalancerHelmManager,
  getDeployedRebalancerWarpRouteIds,
  getRebalancerConfigPath,
} from '../../src/rebalancer/helm.js';
import { REBALANCER_HELM_RELEASE_PREFIX } from '../../src/utils/consts.js';
import { validateRegistryCommit } from '../../src/utils/git.js';
import {
  HelmCommand,
  HelmManager,
  getHelmReleaseName,
  removeHelmRelease,
} from '../../src/utils/helm.js';
import { execCmd } from '../../src/utils/utils.js';
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

async function waitForReleasePodsToTerminate(
  releaseName: string,
  namespace: DeployEnvironment,
): Promise<void> {
  const selector = `app.kubernetes.io/instance=${releaseName}`;
  const timeout = Date.now() + 120_000;

  rootLogger.info(`Waiting for pods from ${releaseName} to terminate`);
  while (Date.now() < timeout) {
    const [pods] = await execCmd([
      'kubectl',
      'get',
      'pods',
      '--namespace',
      namespace,
      '--selector',
      selector,
      '-o',
      'name',
    ]);

    if (pods.trim().length === 0) {
      return;
    }

    await sleep(1000);
  }

  throw new Error(
    `Timed out waiting for pods from ${releaseName} to terminate`,
  );
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const {
    environment,
    warpRouteId,
    metrics,
    registryCommit: registryCommitArg,
    yes: skipConfirmation,
    fleet: fleetName,
  } = await withYes(withMetrics(withRegistryCommit(withWarpRouteId(getArgs()))))
    .describe('fleet', 'rebalancer fleet name')
    .string('fleet')
    .conflicts('fleet', 'warpRouteId')
    .parse();

  if (fleetName && environment !== 'mainnet3') {
    throw new Error(
      `Rebalancer fleets are only defined for mainnet3; received ${environment}`,
    );
  }

  const fleet = fleetName ? getRebalancerFleet(fleetName) : undefined;

  await assertCorrectKubeContext(getEnvironmentConfig(environment));

  if (fleet) {
    let registryCommit: string;
    if (registryCommitArg) {
      registryCommit = registryCommitArg;
    } else {
      const defaultRegistryCommit =
        await RebalancerFleetHelmManager.getDeployedRegistryCommit(
          fleet.name,
          environment,
        );

      if (skipConfirmation) {
        registryCommit = defaultRegistryCommit ?? 'main';
      } else {
        registryCommit = await input({
          message: `[fleet ${fleet.name}] Enter registry version (commit, branch or tag):`,
          default: defaultRegistryCommit,
        });
      }
    }

    await validateRegistryCommit(registryCommit);

    const helmManager = new RebalancerFleetHelmManager(
      fleet,
      environment,
      registryCommit,
      metrics,
    );
    await helmManager.runPreflightChecks();

    rootLogger.warn(
      '⚠️  CUTOVER: pod-name-based Grafana alerts referencing hyperlane-rebalancer-usdc-* release names must be updated. Metric-level warp_route_id alerts are unaffected.',
    );

    for (const memberWarpRouteId of fleet.warpRouteIds) {
      const releaseName = getHelmReleaseName(
        memberWarpRouteId,
        REBALANCER_HELM_RELEASE_PREFIX,
      );
      if (!(await HelmManager.doesHelmReleaseExist(releaseName, environment))) {
        continue;
      }

      rootLogger.info(`Uninstalling per-route rebalancer: ${releaseName}`);
      await removeHelmRelease(releaseName, environment);
      await waitForReleasePodsToTerminate(releaseName, environment);
      rootLogger.info(`Per-route rebalancer terminated: ${releaseName}`);
    }

    await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade);
    return;
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
      ...new Set(deployedPods.map((pod) => pod.warpRouteId)),
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

  if (environment === 'mainnet3') {
    for (const selectedWarpRouteId of warpRouteIds) {
      const owningFleet = rebalancerFleets.find((candidate) =>
        candidate.warpRouteIds.includes(selectedWarpRouteId),
      );
      if (owningFleet) {
        throw new Error(
          `Warp route ${selectedWarpRouteId} is managed by fleet ${owningFleet.name}. Deploy it with --fleet ${owningFleet.name}.`,
        );
      }
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
    if (warpRouteId && orphanedIds.includes(warpRouteId)) {
      rootLogger.error(
        `Warp route "${warpRouteId}" not found in registry. Verify the warp route ID is correct.`,
      );
      process.exit(1);
    }
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

      if (skipConfirmation) {
        registryCommit = defaultRegistryCommit ?? 'main';
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
    const relativeConfigPath = getRebalancerConfigPath(
      environment,
      warpRouteId,
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
