import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { execSync } from 'child_process';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getRegistry } from '../../config/registry.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { WarpRouteMonitorHelmManager } from '../../src/warp/helm.js';
import {
  assertCorrectKubeContext,
  getAgentConfig,
  getArgs,
  getWarpRouteIdsInteractive,
  withWarpRouteId,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function validateRegistryCommit(commit: string) {
  const registry = getRegistry();
  const registryUri = registry.getUri();

  try {
    rootLogger.info(
      chalk.grey.italic(`Attempting to fetch registry commit ${commit}...`),
    );
    execSync(`cd ${registryUri} && git fetch origin ${commit}`, {
      stdio: 'inherit',
    });
    rootLogger.info(chalk.grey.italic('Fetch completed successfully.'));
  } catch (_) {
    rootLogger.error(chalk.red(`Unable to fetch registry commit ${commit}.`));
    process.exit(1);
  }
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId } = await withWarpRouteId(getArgs()).argv;
  const envConfig = getEnvironmentConfig(environment);
  const multiProtocolProvider = await envConfig.getMultiProtocolProvider();

  let warpRouteIds;
  if (warpRouteId) {
    warpRouteIds = [warpRouteId];
  } else {
    warpRouteIds = await getWarpRouteIdsInteractive();
  }

  const registryCommit = await input({
    message:
      'Enter the registry version to use (can be a commit, branch or tag):',
  });
  await validateRegistryCommit(registryCommit);

  await assertCorrectKubeContext(getEnvironmentConfig(environment));
  const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);

  const deployWarpMonitor = async (warpRouteId: string) => {
    const helmManager = new WarpRouteMonitorHelmManager(
      warpRouteId,
      environment,
      agentConfig.environmentChainNames,
      registryCommit,
    );
    await helmManager.runPreflightChecks(multiProtocolProvider);
    await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade);
  };

  // First try to uninstall any stale Warp Monitors.
  // This can happen if a Warp Route ID is changed or removed.
  await WarpRouteMonitorHelmManager.uninstallUnknownWarpMonitorReleases(
    environment,
  );

  for (const id of warpRouteIds) {
    rootLogger.info(`Deploying Warp Monitor for Warp Route ID: ${id}`);
    await deployWarpMonitor(id);
  }
}

main()
  .then(() => rootLogger.info('Deploy successful!'))
  .catch(rootLogger.error);
