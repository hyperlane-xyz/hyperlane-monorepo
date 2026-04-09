import chalk from 'chalk';
import { Gauge, Registry } from 'prom-client';

import { submitMetrics } from '@hyperlane-xyz/metrics';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { ChainName } from '@hyperlane-xyz/sdk';

import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { DEFAULT_REGISTRY_URI } from '../../config/registry.js';
import {
  getWarpConfigMap,
  getWarpConfigMapFromMergedRegistry,
} from '../../config/warp.js';
import { getEnvironmentConfig } from '../core-utils.js';

import {
  getCheckWarpDeployArgs,
  getCheckerViolationsGaugeObj,
} from './check-utils.js';
import {
  logWarpRouteCheckResult,
  runWarpRouteCheckFromRegistry,
} from './check-warp-route.js';

async function main() {
  const { environment, chains, pushMetrics } =
    await getCheckWarpDeployArgs().argv;

  const metricsRegister = new Registry();
  const checkerViolationsGauge = new Gauge(
    getCheckerViolationsGaugeObj(metricsRegister),
  );
  metricsRegister.registerMetric(checkerViolationsGauge);

  const failedWarpRoutesChecks: string[] = [];

  const routesToSkip: string[] = [
    WarpRouteIds.ArbitrumBaseBlastBscEthereumGnosisLiskMantleModeOptimismPolygonScrollZeroNetworkZoraMainnet,
    'EDGEN/bsc-edgenchain-ethereum',
    'INJ/inevm-injective',
    'USDC/ethereum-inevm',
    'USDT/ethereum-inevm',
    'WBTC/ethereum-form',
    'WSTETH/ethereum-form',
    'USDT/ethereum-form',
    'USDC/ethereum-form',
    'TRUMP/arbitrum-avalanche-base-flowmainnet-form-optimism-solanamainnet-worldchain',
    'AIXBT/base-form',
    'FORM/ethereum-form',
    'GAME/base-form',
    // Skip until Paradex executes hyperevm upgrade on their side
    WarpRouteIds.ParadexUSDC,
  ];

  const registries = [DEFAULT_REGISTRY_URI];
  const registry = getRegistry({
    registryUris: registries,
    enableProxy: true,
  });

  const registryWarpDeployConfigMap =
    await getWarpConfigMapFromMergedRegistry(registries);

  console.log(chalk.yellow('Skipping the following warp routes:'));
  routesToSkip.forEach((route) => console.log(chalk.yellow(`- ${route}`)));

  const isTestnetRoute = async (warpRouteConfig: any) => {
    for (const chain of Object.keys(warpRouteConfig)) {
      const chainMetadata = await registry.getChainMetadata(chain);
      if (chainMetadata?.isTestnet) return true;
    }
    return false;
  };

  const envConfig = getEnvironmentConfig(environment);
  const warpRouteIds = Object.keys(registryWarpDeployConfigMap);

  const routesWithUnsupportedChains: string[] = [];

  const filterResults = await Promise.all(
    warpRouteIds.map(async (warpRouteId) => {
      const warpRouteConfig = registryWarpDeployConfigMap[warpRouteId];
      const isTestnet = await isTestnetRoute(warpRouteConfig);
      const shouldCheck =
        (environment === 'mainnet3' && !isTestnet) ||
        (environment === 'testnet4' && isTestnet);

      if (!shouldCheck || routesToSkip.includes(warpRouteId)) {
        return false;
      }

      const routeChains = Object.keys(warpRouteConfig);
      const unsupportedChains = routeChains.filter(
        (chain) => !envConfig.supportedChainNames.includes(chain),
      );
      if (unsupportedChains.length > 0) {
        routesWithUnsupportedChains.push(
          `${warpRouteId} (${unsupportedChains.join(', ')})`,
        );
        return false;
      }

      return true;
    }),
  );

  if (routesWithUnsupportedChains.length > 0) {
    console.log(
      chalk.yellow(
        `Skipping ${routesWithUnsupportedChains.length} routes with unsupported chains:`,
      ),
    );
    routesWithUnsupportedChains.forEach((route) =>
      console.log(chalk.yellow(`  - ${route}`)),
    );
  }

  const warpIdsToCheck = warpRouteIds.filter(
    (_, index) => filterResults[index],
  );

  const warpConfigChains = new Set<ChainName>();
  warpIdsToCheck.forEach((warpRouteId) => {
    const warpRouteConfig = registryWarpDeployConfigMap[warpRouteId];
    Object.keys(warpRouteConfig).forEach((chain) =>
      warpConfigChains.add(chain),
    );
  });

  console.log(
    `Checking ${warpIdsToCheck.length} routes across chains: ${Array.from(warpConfigChains).join(', ')}`,
  );

  // Get the multiprovider once to avoid recreating it for each warp route.
  // We specify the chains to avoid creating a multiprovider for all chains.
  // This ensures that we don't fail to fetch secrets for new chains in the cron job.
  // Use default values for context, role, and useSecrets.
  const multiProvider = await envConfig.getMultiProvider(
    undefined,
    undefined,
    undefined,
    Array.from(warpConfigChains),
  );

  const warpDeployConfigMap = await getWarpConfigMap(
    multiProvider,
    envConfig,
    registries,
    false,
    warpIdsToCheck,
  );

  // TODO: consider retrying this if check throws an error
  for (const warpRouteId of warpIdsToCheck) {
    console.log(`\nChecking warp route ${warpRouteId}...`);

    try {
      const result = await runWarpRouteCheckFromRegistry({
        chains,
        multiProvider,
        registryUris: registries,
        warpRouteId,
        warpDeployConfig: warpDeployConfigMap[warpRouteId],
      });

      if (result.violations.length > 0) {
        logWarpRouteCheckResult(result);
        if (pushMetrics) {
          for (const violation of result.violations) {
            checkerViolationsGauge
              .labels({
                actual: violation.actual,
                chain: violation.chain,
                contract_name: violation.name,
                expected: violation.expected,
                module: 'warp',
                remote: '',
                sub_type: '',
                type: violation.type,
                warp_route_id: warpRouteId,
              })
              .set(1);
            console.log(
              `Violation: ${violation.name} on ${violation.chain} with ${violation.actual} ${violation.type} ${violation.expected} pushed to metrics`,
            );
          }
        }
      } else {
        console.info(chalk.green(`warp checker found no violations`));
      }

      if (pushMetrics) {
        await submitMetrics(
          metricsRegister,
          `check-warp-deploy-${environment}`,
          {
            overwriteAllMetrics: true,
          },
        );
      }
    } catch (e) {
      console.error(
        chalk.red(`Error checking warp route ${warpRouteId}: ${e}`),
      );
      failedWarpRoutesChecks.push(warpRouteId);
    }
  }

  if (failedWarpRoutesChecks.length > 0) {
    console.error(
      chalk.red(
        `Failed to check warp routes: ${failedWarpRoutesChecks.join(', ')}`,
      ),
    );
    process.exit(1);
  }

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
