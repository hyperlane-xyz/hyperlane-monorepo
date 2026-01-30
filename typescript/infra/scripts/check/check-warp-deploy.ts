import chalk from 'chalk';
import { Gauge, Registry } from 'prom-client';

import { submitMetrics } from '@hyperlane-xyz/metrics';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { ChainName } from '@hyperlane-xyz/sdk';

import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { DEFAULT_REGISTRY_URI } from '../../config/registry.js';
import { getWarpConfigMapFromMergedRegistry } from '../../config/warp.js';
import { Modules } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

import {
  getCheckWarpDeployArgs,
  getCheckerViolationsGaugeObj,
  getGovernor,
  logViolations,
} from './check-utils.js';

async function main() {
  const { environment, asDeployer, chains, fork, context, pushMetrics } =
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
  ];

  const registries = [DEFAULT_REGISTRY_URI];
  const registry = getRegistry({
    registryUris: registries,
    enableProxy: true,
  });

  const warpCoreConfigMap =
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

  const warpConfigChains = new Set<ChainName>();
  const warpRouteIds = Object.keys(warpCoreConfigMap);

  const filterResults = await Promise.all(
    warpRouteIds.map(async (warpRouteId) => {
      const warpRouteConfig = warpCoreConfigMap[warpRouteId];
      const isTestnet = await isTestnetRoute(warpRouteConfig);
      const shouldCheck =
        (environment === 'mainnet3' && !isTestnet) ||
        (environment === 'testnet4' && isTestnet);
      return shouldCheck && !routesToSkip.includes(warpRouteId);
    }),
  );

  const warpIdsToCheck = warpRouteIds.filter(
    (_, index) => filterResults[index],
  );

  warpIdsToCheck.forEach((warpRouteId) => {
    const warpRouteConfig = warpCoreConfigMap[warpRouteId];
    Object.keys(warpRouteConfig).forEach((chain) =>
      warpConfigChains.add(chain),
    );
  });

  const envConfig = getEnvironmentConfig(environment);

  const unsupportedChains = Array.from(warpConfigChains).filter(
    (chain) => !envConfig.supportedChainNames.includes(chain),
  );
  if (unsupportedChains.length > 0) {
    console.log(
      chalk.yellow(
        `Skipping unsupported chain legs: ${unsupportedChains.join(', ')}`,
      ),
    );
  }

  const supportedWarpChains = Array.from(warpConfigChains).filter((chain) =>
    envConfig.supportedChainNames.includes(chain),
  );

  console.log(`Checking chains: ${supportedWarpChains.join(', ')}`);

  const multiProvider = await envConfig.getMultiProvider(
    undefined,
    undefined,
    undefined,
    supportedWarpChains,
  );

  // TODO: consider retrying this if check throws an error
  for (const warpRouteId of warpIdsToCheck) {
    console.log(`\nChecking warp route ${warpRouteId}...`);
    const warpModule = Modules.WARP;

    try {
      const governor = await getGovernor(
        warpModule,
        context,
        environment,
        asDeployer,
        warpRouteId,
        chains,
        fork,
        false,
        multiProvider,
        registries,
      );

      await governor.check();

      const violations: any = governor.getCheckerViolations();
      if (violations.length > 0) {
        logViolations(violations);

        if (pushMetrics) {
          for (const violation of violations) {
            checkerViolationsGauge
              .labels({
                module: warpModule,
                warp_route_id: warpRouteId,
                chain: violation.chain,
                contract_name: violation.name,
                type: violation.type,
                actual: violation.actual,
                expected: violation.expected,
              })
              .set(1);
            console.log(
              `Violation: ${violation.name} on ${violation.chain} with ${violation.actual} ${violation.type} ${violation.expected} pushed to metrics`,
            );
          }
        }
      } else {
        console.info(chalk.green(`${warpModule} checker found no violations`));
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
