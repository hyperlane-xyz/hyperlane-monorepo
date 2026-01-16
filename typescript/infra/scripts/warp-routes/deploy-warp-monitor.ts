import { input } from '@inquirer/prompts';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
  timedAsync,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getWarpCoreConfig } from '../../config/registry.js';
import { validateRegistryCommit } from '../../src/utils/git.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { WarpRouteMonitorHelmManager } from '../../src/warp-monitor/helm.js';
import {
  assertCorrectKubeContext,
  getAgentConfig,
  getArgs,
  getMultiProtocolProvider,
  getWarpRouteIdsInteractive,
  withRegistryCommit,
  withWarpRouteId,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const {
    environment,
    warpRouteId,
    registryCommit: registryCommitArg,
  } = await withRegistryCommit(withWarpRouteId(getArgs())).argv;
  await timedAsync('assertCorrectKubeContext', () =>
    assertCorrectKubeContext(getEnvironmentConfig(environment)),
  );

  const envConfig = getEnvironmentConfig(environment);

  // Get warp route IDs first to determine which chains we need
  let warpRouteIds;
  if (warpRouteId) {
    warpRouteIds = [warpRouteId];
  } else {
    warpRouteIds = await getWarpRouteIdsInteractive(environment);
  }

  // Extract chains from warp routes to only fetch secrets for needed chains
  const warpRouteChains = new Set<string>();
  for (const id of warpRouteIds) {
    const warpConfig = getWarpCoreConfig(id);
    for (const token of warpConfig.tokens) {
      warpRouteChains.add(token.chainName);
    }
  }
  const chainsNeeded = Array.from(warpRouteChains);
  rootLogger.debug(
    `Loading secrets for ${chainsNeeded.length} chains: ${chainsNeeded.join(', ')}`,
  );

  const registryCommit =
    registryCommitArg ??
    (await input({
      message:
        'Enter the registry version to use (can be a commit, branch or tag):',
    }));

  // Only fetch secrets for the chains in the warp routes (optimization)
  const [registry] = await timedAsync(
    'getRegistry + validateRegistryCommit',
    () =>
      Promise.all([
        envConfig.getRegistry(true, chainsNeeded),
        validateRegistryCommit(registryCommit),
      ]),
  );
  const multiProtocolProvider = await timedAsync(
    'getMultiProtocolProvider',
    () => getMultiProtocolProvider(registry),
  );

  const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);

  const deployWarpMonitor = async (warpRouteId: string) => {
    const helmManager = new WarpRouteMonitorHelmManager(
      warpRouteId,
      environment,
      agentConfig.environmentChainNames,
      registryCommit,
    );
    await timedAsync(`runPreflightChecks(${warpRouteId})`, () =>
      helmManager.runPreflightChecks(multiProtocolProvider),
    );
    await timedAsync(`runHelmCommand(${warpRouteId})`, () =>
      helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade),
    );
  };

  // Only run cleanup when deploying all warp routes (no specific ID provided).
  // This cleanup is slow (~20s) because it reads all warp routes from the registry.
  if (!warpRouteId) {
    await timedAsync('uninstallUnknownWarpMonitorReleases', () =>
      WarpRouteMonitorHelmManager.uninstallUnknownWarpMonitorReleases(
        environment,
      ),
    );
  }

  for (const id of warpRouteIds) {
    rootLogger.info(`Deploying Warp Monitor for Warp Route ID: ${id}`);
    await deployWarpMonitor(id);
  }
}

main()
  .then(() => rootLogger.info('Deploy successful!'))
  .catch(rootLogger.error);
