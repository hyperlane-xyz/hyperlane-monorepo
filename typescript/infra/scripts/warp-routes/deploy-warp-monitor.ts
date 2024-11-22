import { checkbox } from '@inquirer/prompts';
import yargs from 'yargs';

import { Contexts } from '../../config/contexts.js';
import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { HelmCommand } from '../../src/utils/helm.js';
import { WarpRouteMonitorHelmManager } from '../../src/warp/helm.js';
import {
  assertCorrectKubeContext,
  getAgentConfig,
  getArgs,
  withWarpRouteId,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment, warpRouteId } = await withWarpRouteId(getArgs()).argv;

  let warpRouteIds;
  if (warpRouteId) {
    warpRouteIds = [warpRouteId];
  } else {
    warpRouteIds = await getWarpRouteIdsInteractive();
  }

  await assertCorrectKubeContext(getEnvironmentConfig(environment));
  const agentConfig = getAgentConfig(Contexts.Hyperlane, environment);

  const deployWarpMonitor = async (warpRouteId: string) => {
    const helmManager = new WarpRouteMonitorHelmManager(
      warpRouteId,
      environment,
      agentConfig.environmentChainNames,
    );
    await helmManager.runHelmCommand(HelmCommand.InstallOrUpgrade);
  };

  for (const id of warpRouteIds) {
    console.log(`Deploying Warp Monitor for Warp Route ID: ${id}`);
    await deployWarpMonitor(id);
  }
}

async function getWarpRouteIdsInteractive() {
  const choices = Object.values(WarpRouteIds).map((id) => ({
    value: id,
  }));

  let selection: WarpRouteIds[] = [];

  while (!selection.length) {
    selection = await checkbox({
      message: 'Select Warp Route IDs to deploy',
      choices,
      pageSize: 30,
    });
    if (!selection.length) {
      console.log('Please select at least one Warp Route ID');
    }
  }

  return selection;
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
