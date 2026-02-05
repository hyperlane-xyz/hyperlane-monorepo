import { checkbox, input } from '@inquirer/prompts';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
  timedAsync,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getWarpCoreConfig } from '../../config/registry.js';
import { WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX } from '../../src/utils/consts.js';
import { validateRegistryCommit } from '../../src/utils/git.js';
import { HelmCommand } from '../../src/utils/helm.js';
import {
  WarpRouteMonitorHelmManager,
  getDeployedWarpMonitorWarpRouteIds,
} from '../../src/warp-monitor/helm.js';
import {
  assertCorrectKubeContext,
  filterOrphanedWarpRouteIds,
  getAgentConfig,
  getArgs,
  getMultiProtocolProvider,
  withRegistryCommit,
  withWarpRouteId,
  withYes,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const {
    environment,
    warpRouteId,
    registryCommit: registryCommitArg,
    yes: skipConfirmation,
  } = await withYes(withRegistryCommit(withWarpRouteId(getArgs()))).argv;
  await timedAsync('assertCorrectKubeContext', () =>
    assertCorrectKubeContext(getEnvironmentConfig(environment)),
  );

  const envConfig = getEnvironmentConfig(environment);

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
      helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade),
    );
  };

  for (const id of validWarpRouteIds) {
    rootLogger.info(`Deploying Warp Monitor for Warp Route ID: ${id}`);
    await deployWarpMonitor(id);
  }
}

main()
  .then(() => rootLogger.info('Deploy successful!'))
  .catch(rootLogger.error);
