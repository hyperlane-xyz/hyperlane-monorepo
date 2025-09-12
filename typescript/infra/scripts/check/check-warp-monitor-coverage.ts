import { rootLogger } from '@hyperlane-xyz/utils';

import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { DEFAULT_REGISTRY_URI } from '../../config/registry.js';
import { getWarpConfigMapFromMergedRegistry } from '../../config/warp.js';
import { RebalancerHelmManager } from '../../src/rebalancer/helm.js';
import { HelmManager, getHelmReleaseName } from '../../src/utils/helm.js';
import { WarpRouteMonitorHelmManager } from '../../src/warp/helm.js';
import { getArgs } from '../agent-utils.js';

async function main() {
  const { environment } = await getArgs().argv;

  const registries = [DEFAULT_REGISTRY_URI];

  const warpCoreConfigMap =
    await getWarpConfigMapFromMergedRegistry(registries);

  const warpRouteIdsRegistry = Object.keys(warpCoreConfigMap);
  const warpRouteIdsEnum = Object.values(WarpRouteIds);

  const warpRouteIdsToSkip = [
    'EDGEN/bsc-edgenchain-ethereum',
    'USDC/mainnet-cctp',
    'EZETHSTAGE/renzo-stage',
    'PZETHSTAGE/berachain-ethereum-swell-unichain-zircuit',
    'REZSTAGING/base-ethereum-unichain',
    'TIA/basesepolia-celestiatestnet',
    'USDC/paradexsepolia',
    'USDC/testnet-cctp',
    'USDCSTAGE/arbitrum-base-ethereum-ink-optimism-solanamainnet-superseed',
    'USDN/auroratestnet-nobletestnet',
    'oUSDT/staging',
  ];

  const warpRoutesSet = new Set([...warpRouteIdsEnum, ...warpRouteIdsRegistry]);

  const warpRouteIds = Array.from(warpRoutesSet).filter(
    (warpRouteId) => !warpRouteIdsToSkip.includes(warpRouteId),
  );

  // Helper function to check if a pod exists and is running
  const checkPodStatus = async (
    podReleaseName: string,
    warpRouteId: string,
    podType: string,
  ): Promise<boolean> => {
    try {
      const podStatus = await HelmManager.runK8sCommand(
        'get pod',
        podReleaseName,
        environment,
      );
      if (podStatus) {
        rootLogger.debug(`${podType} pod for ${warpRouteId} is running`);
        return true;
      }
      return false;
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        rootLogger.debug(`${podType} pod for ${warpRouteId} not found`);
        return false;
      }
      // Re-throw other errors to be handled by the caller
      throw error;
    }
  };

  // Execute pod status checks in parallel
  const warpMonitorPodStatusPromises = warpRouteIds.map(async (warpRouteId) => {
    try {
      const monitorPodReleaseName = `${getHelmReleaseName(warpRouteId, WarpRouteMonitorHelmManager.helmReleasePrefix)}-0`;

      // First try to check monitor pod
      const monitorPodRunning = await checkPodStatus(
        monitorPodReleaseName,
        warpRouteId,
        'Monitor',
      );
      if (monitorPodRunning) {
        return { warpRouteId, status: true };
      }

      // If monitor pod is not running, check rebalancer pod
      const rebalancerPodReleaseName = `${getHelmReleaseName(warpRouteId, RebalancerHelmManager.helmReleasePrefix)}-0`;
      const rebalancerPodRunning = await checkPodStatus(
        rebalancerPodReleaseName,
        warpRouteId,
        'Rebalancer',
      );

      return { warpRouteId, status: rebalancerPodRunning };
    } catch (error) {
      // Handle any unexpected errors (network issues, permission problems, etc.)
      rootLogger.debug(`Error checking pods for ${warpRouteId}:`, error);
      return { warpRouteId, status: false };
    }
  });

  const warpMonitorPodStatusResults = await Promise.all(
    warpMonitorPodStatusPromises,
  );

  // Convert results back to the original format
  const warpMonitorPodStatuses: Record<string, boolean> = {};
  for (const result of warpMonitorPodStatusResults) {
    warpMonitorPodStatuses[result.warpRouteId] = result.status;
  }

  if (Object.values(warpMonitorPodStatuses).every((status) => status)) {
    rootLogger.info('All pods are running');
    return;
  }

  // console table of pod statuses with false values only
  console.table(
    Object.entries(warpMonitorPodStatuses)
      .map(([warpRouteId, status]) => ({
        'Warp Route ID': warpRouteId,
        Status: status ? '✅' : '❌',
      }))
      .filter(({ Status }) => Status === '❌'),
  );
}

main();
