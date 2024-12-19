import { checkbox } from '@inquirer/prompts';

import { Contexts } from '../../config/contexts.js';
import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
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

  // First try to uninstall any stale Warp Monitors.
  // This can happen if a Warp Route ID is changed or removed.
  await WarpRouteMonitorHelmManager.uninstallUnknownWarpMonitorReleases(
    environment,
  );

  for (const id of warpRouteIds) {
    console.log(`Deploying Warp Monitor for Warp Route ID: ${id}`);
    await deployWarpMonitor(id);
  }
}

main()
  .then(() => console.log('Deploy successful!'))
  .catch(console.error);
