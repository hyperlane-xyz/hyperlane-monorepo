import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { execSync } from 'child_process';
import path from 'path';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';
import { RebalancerHelmManager } from '../../src/rebalancer/helm.js';
import { HelmCommand } from '../../src/utils/helm.js';
import {
  assertCorrectKubeContext,
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

const REBALANCER_CONFIG_PATH_PREFIX =
  'typescript/infra/config/environments/mainnet3/rebalancer/rebalancerConfigs';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { environment, warpRouteId } = await withWarpRouteId(getArgs()).parse();

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

  rootLogger.info(
    `Deploying Rebalancer for Route ID: ${warpRouteIds.join(', ')}`,
  );

  const deployRebalancer = async (warpRouteId: string) => {
    const rebalancerConfigPath = path.join(
      REBALANCER_CONFIG_PATH_PREFIX,
      `${warpRouteId}-config.yaml`,
    );

    const helmManager = new RebalancerHelmManager(
      warpRouteId,
      environment,
      registryCommit,
      rebalancerConfigPath,
      true,
    );
    await helmManager.runPreflightChecks();
    // await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade);
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
