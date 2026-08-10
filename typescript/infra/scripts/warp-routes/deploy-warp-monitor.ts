import { checkbox, input } from '@inquirer/prompts';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
  timedAsync,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { mainnetDockerTags } from '../../config/docker.js';
import { getWarpCoreConfig } from '../../config/registry.js';
import { DeployEnvironment } from '../../src/config/deploy-environment.js';
import { getDeployedRebalancerWarpRouteIds } from '../../src/rebalancer/helm.js';
import {
  REBALANCER_HELM_RELEASE_PREFIX,
  WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX,
} from '../../src/utils/consts.js';
import { validateRegistryCommit } from '../../src/utils/git.js';
import { HelmCommand } from '../../src/utils/helm.js';
import {
  CentralizedWarpRouteMonitorHelmManager,
  WarpRouteMonitorHelmManager,
  getDeployedCentralizedWarpMonitorWarpRouteIds,
  getDeployedWarpMonitorWarpRouteIds,
} from '../../src/warp-monitor/helm.js';
import {
  assertCorrectKubeContext,
  filterOrphanedWarpRouteIds,
  getAgentConfig,
  getArgs,
  getMultiProtocolProvider,
  withDryRun,
  withRegistryCommit,
  withWarpRouteId,
  withYes,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

function dedupeAndSortWarpRouteIds(
  ids: (string | undefined | null)[],
): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))].sort();
}

// Deploys the single centralized multi-route monitor. Routes currently owned by
// a deployed rebalancer are auto-derived from the live cluster: they are both
// monitored and passed as the shared-balance skip list, so their shared-balance
// metrics are not double-emitted while the rest of their coverage is kept.
async function deployCentralizedWarpMonitor({
  environment,
  warpRouteId,
  registryCommitArg,
  skipConfirmation,
  imageTagArg,
  dryRun,
}: {
  environment: DeployEnvironment;
  warpRouteId?: string;
  registryCommitArg?: string;
  skipConfirmation: boolean;
  imageTagArg?: string;
  dryRun: boolean;
}) {
  let registryCommit: string;
  if (registryCommitArg) {
    registryCommit = registryCommitArg;
  } else if (skipConfirmation) {
    registryCommit = 'main';
  } else {
    registryCommit = await input({
      message: 'Enter registry version (commit, branch or tag):',
      default: 'main',
    });
  }
  await validateRegistryCommit(registryCommit);

  const rebalancerPods = await getDeployedRebalancerWarpRouteIds(
    environment,
    REBALANCER_HELM_RELEASE_PREFIX,
  );
  const rebalancerWarpRouteIds = dedupeAndSortWarpRouteIds(
    rebalancerPods.map((p) => p.warpRouteId),
  );
  // Rebalancers already emit shared-balance metrics for these routes, so the
  // monitor must not double-emit them — but it still monitors everything else
  // (pending transfers, projected deficit, inventory) for them.
  const skipSharedBalanceWarpRouteIds = rebalancerWarpRouteIds;
  rootLogger.info(
    `Rebalancer-owned routes (${rebalancerWarpRouteIds.length}) — monitored, but shared-balance metrics suppressed:\n${rebalancerWarpRouteIds.map((id) => `  - ${id}`).join('\n')}`,
  );

  const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);
  const imageTag = imageTagArg ?? mainnetDockerTags.warpMonitor;

  // Build the monitored whitelist as the UNION of every source so the singleton
  // is always extended, never replaced or frozen: the centralized monitor's own
  // currently-deployed route list (its durable Deployment whitelist), the
  // currently-deployed per-route monitors (so a route added via the per-route
  // flow gets folded in), an explicit --warp-route-id when provided (added on
  // top, not substituted), and rebalancer-owned routes (kept for full
  // non-shared-balance coverage). Every id is then validated against the
  // registry so an unknown or orphaned id never silently deploys, and stale
  // entries are dropped. This keeps scope to the mainnet fleet rather than
  // every registry route, so it never pages on testnet/staging routes that were
  // never monitored.
  const deployedCentralized =
    await getDeployedCentralizedWarpMonitorWarpRouteIds(environment);
  const deployedMonitors = await getDeployedWarpMonitorWarpRouteIds(
    environment,
    WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX,
  );
  const deployedPerRouteIds = deployedMonitors
    .map((p) => p.warpRouteId)
    .filter((id): id is string => !!id);
  const candidateWarpRouteIds = [
    ...deployedCentralized,
    ...deployedPerRouteIds,
    ...(warpRouteId ? [warpRouteId] : []),
    ...rebalancerWarpRouteIds,
  ];
  rootLogger.info(
    `Whitelist union — centralized: ${deployedCentralized.length}, per-route: ${dedupeAndSortWarpRouteIds(deployedPerRouteIds).length}, explicit: ${warpRouteId ? 1 : 0}, rebalancer: ${rebalancerWarpRouteIds.length}`,
  );

  const { validIds: warpRouteIds, orphanedIds } = filterOrphanedWarpRouteIds(
    dedupeAndSortWarpRouteIds(candidateWarpRouteIds),
  );
  // Guard against a typo'd --warp-route-id: an explicit id that fails registry
  // validation is a user error, not a stale entry to silently drop.
  if (warpRouteId && orphanedIds.includes(warpRouteId)) {
    rootLogger.error(
      `Warp route "${warpRouteId}" not found in registry. Verify the warp route ID is correct.`,
    );
    process.exit(1);
  }
  if (orphanedIds.length > 0) {
    rootLogger.warn(
      `Excluding ${orphanedIds.length} route(s) not in the selected registry:\n${orphanedIds.map((id) => `  - ${id}`).join('\n')}`,
    );
  }

  if (warpRouteIds.length === 0) {
    rootLogger.error(
      'No warp routes to monitor: found no current centralized monitor, no per-route monitors, no rebalancer routes, and no --warp-route-id provided.',
    );
    process.exit(1);
  }
  rootLogger.info(
    `Centralized monitor whitelist: ${warpRouteIds.length} route(s)`,
  );

  const helmManager = new CentralizedWarpRouteMonitorHelmManager(
    environment,
    agentConfig.environmentChainNames,
    registryCommit,
    skipSharedBalanceWarpRouteIds,
    imageTag,
    warpRouteIds,
  );
  rootLogger.info(
    `Deploying centralized warp monitor (image ${imageTag}, ${warpRouteIds.length} route(s))`,
  );
  await timedAsync('runHelmCommand(centralized)', () =>
    helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade, { dryRun }),
  );
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const {
    environment,
    warpRouteId,
    registryCommit: registryCommitArg,
    yes: skipConfirmation,
    centralized,
    imageTag: imageTagArg,
    dryRun,
  } = await withDryRun(
    withYes(withRegistryCommit(withWarpRouteId(getArgs())))
      .boolean('centralized')
      .describe(
        'centralized',
        'Deploy the single centralized multi-route monitor instead of per-route monitors',
      )
      .default('centralized', false)
      .string('imageTag')
      .describe(
        'imageTag',
        'node-services image tag for the centralized monitor (defaults to the pinned mainnet warpMonitor tag)',
      ),
  ).argv;
  await timedAsync('assertCorrectKubeContext', () =>
    assertCorrectKubeContext(getEnvironmentConfig(environment)),
  );

  const envConfig = getEnvironmentConfig(environment);

  if (centralized) {
    await deployCentralizedWarpMonitor({
      environment,
      warpRouteId,
      registryCommitArg,
      skipConfirmation,
      imageTagArg,
      dryRun,
    });
    return;
  }

  let warpRouteIds: string[];
  if (warpRouteId) {
    warpRouteIds = [warpRouteId];
  } else {
    const deployedPods = await getDeployedWarpMonitorWarpRouteIds(
      environment,
      WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX,
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
        'No deployed warp monitors found. Use --warp-route-id to deploy a new one.',
      );
      process.exit(1);
    }

    warpRouteIds = await checkbox({
      message: 'Select warp monitors to redeploy',
      choices: deployedIds.map((id) => ({ value: id })),
      pageSize: 30,
    });

    if (warpRouteIds.length === 0) {
      rootLogger.info('No warp monitors selected');
      process.exit(0);
    }
  }

  const { validIds: validWarpRouteIds, orphanedIds } =
    filterOrphanedWarpRouteIds(warpRouteIds);

  if (orphanedIds.length > 0) {
    rootLogger.warn(
      `Skipping ${orphanedIds.length} orphaned monitors (warp route no longer in registry):\n${orphanedIds.map((id) => `  - ${id}`).join('\n')}`,
    );
    rootLogger.warn('Run helm uninstall manually to remove these monitors');
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

  // Extract chains from warp routes to only fetch secrets for needed chains
  const warpRouteChains = new Set<string>();
  for (const id of validWarpRouteIds) {
    const warpConfig = getWarpCoreConfig(id);
    for (const token of warpConfig.tokens) {
      warpRouteChains.add(token.chainName);
    }
  }
  const chainsNeeded = Array.from(warpRouteChains);
  rootLogger.debug(
    `Loading secrets for ${chainsNeeded.length} chains: ${chainsNeeded.join(', ')}`,
  );

  const registry = await timedAsync('getRegistry', () =>
    envConfig.getRegistry(true, chainsNeeded),
  );
  const multiProtocolProvider = await timedAsync(
    'getMultiProtocolProvider',
    () => getMultiProtocolProvider(registry),
  );

  const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);

  const validatedCommits = new Set<string>();

  const deployWarpMonitor = async (warpRouteId: string) => {
    let registryCommit: string;
    if (registryCommitArg) {
      registryCommit = registryCommitArg;
    } else {
      const defaultRegistryCommit =
        await WarpRouteMonitorHelmManager.getDeployedRegistryCommit(
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

    const helmManager = new WarpRouteMonitorHelmManager(
      warpRouteId,
      environment,
      agentConfig.environmentChainNames,
      registryCommit,
    );
    await timedAsync(`runPreflightChecks(${warpRouteId})`, () =>
      helmManager.runPreflightChecks(multiProtocolProvider, skipConfirmation),
    );
    await timedAsync(`runHelmCommand(${warpRouteId})`, () =>
      helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade, { dryRun }),
    );
  };

  for (const id of validWarpRouteIds) {
    rootLogger.info(`Deploying Warp Monitor for Warp Route ID: ${id}`);
    await deployWarpMonitor(id);
  }
}

main()
  .then(() => rootLogger.info('Deploy successful!'))
  .catch((err) => {
    rootLogger.error(err);
    process.exit(1);
  });
