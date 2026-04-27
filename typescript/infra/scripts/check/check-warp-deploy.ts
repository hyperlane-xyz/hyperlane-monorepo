import chalk from 'chalk';
import { Gauge, Registry } from 'prom-client';
import { stringify as yamlStringify } from 'yaml';

import { submitMetrics } from '@hyperlane-xyz/metrics';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  type ChainName,
  MultiProvider,
  type WarpCoreConfig,
  type WarpRouteCheckResult,
  type WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigMailboxRequiredSchema,
  checkWarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { assert, objFilter } from '@hyperlane-xyz/utils';

import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { DEFAULT_REGISTRY_URI } from '../../config/registry.js';
import {
  getWarpConfig,
  getWarpConfigGetterInputs,
  getWarpDeployConfigFromMergedRegistry,
  getWarpConfigMapFromMergedRegistry,
  warpConfigGetterMap,
} from '../../config/warp.js';
import { type EnvironmentConfig } from '../../src/config/environment.js';
import { getEnvironmentConfig } from '../core-utils.js';

import {
  getCheckWarpDeployArgs,
  getCheckerViolationsGaugeObj,
} from './check-utils.js';

const ROUTES_TO_SKIP: string[] = [
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

async function main() {
  const { environment, chains, pushMetrics } =
    await getCheckWarpDeployArgs().argv;

  const metricsRegister = new Registry();
  const checkerViolationsGauge = new Gauge(
    getCheckerViolationsGaugeObj(metricsRegister),
  );
  metricsRegister.registerMetric(checkerViolationsGauge);

  const failedWarpRoutesChecks: string[] = [];

  const registries = [DEFAULT_REGISTRY_URI];
  const registry = getRegistry({
    registryUris: registries,
    enableProxy: true,
  });

  const registryWarpDeployConfigMap =
    await getWarpConfigMapFromMergedRegistry(registries);

  console.log(chalk.yellow('Skipping the following warp routes:'));
  ROUTES_TO_SKIP.forEach((route) => console.log(chalk.yellow(`- ${route}`)));

  const envConfig = getEnvironmentConfig(environment);
  const {
    routesWithUnsupportedChains: registryRoutesWithUnsupportedChains,
    warpIdsToCheck: candidateWarpIdsToCheck,
  } = await getWarpIdsToCheck({
    environment,
    envConfig,
    registry,
    registryWarpDeployConfigMap,
  });
  // Getter inputs only need env-wide chain metadata/core addresses, not signers.
  // Keep the checker multiprovider narrow while avoiding missing-chain lookups in code getters.
  const getterInputsRegistry = await envConfig.getRegistry(false);
  const getterInputsMultiProvider = new MultiProvider(
    await getterInputsRegistry.getMetadata(),
  );
  const warpConfigGetterInputs = await getWarpConfigGetterInputs(
    getterInputsMultiProvider,
    envConfig,
  );
  const {
    routesWithUnsupportedChains: getterRoutesWithUnsupportedChains,
    warpCoreConfigMap,
    warpDeployConfigMap,
    failedWarpRouteConfigLoads,
  } = await getWarpConfigsToCheck({
    envConfig,
    getterInputsMultiProvider,
    registry,
    registryUris: registries,
    registryWarpDeployConfigMap,
    warpConfigGetterInputs,
    warpRouteIds: candidateWarpIdsToCheck,
  });
  failedWarpRoutesChecks.push(...failedWarpRouteConfigLoads);

  const routesWithUnsupportedChains = [
    ...registryRoutesWithUnsupportedChains,
    ...getterRoutesWithUnsupportedChains,
  ];
  logUnsupportedRoutes(routesWithUnsupportedChains);

  const warpIdsToCheck = Object.keys(warpDeployConfigMap);
  const warpConfigChains = getWarpConfigChains({
    warpCoreConfigMap,
    warpDeployConfigMap,
    warpRouteIds: warpIdsToCheck,
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

  // TODO: consider retrying this if check throws an error
  for (const warpRouteId of warpIdsToCheck) {
    console.log(`\nChecking warp route ${warpRouteId}...`);

    try {
      const warpDeployConfig = warpDeployConfigMap[warpRouteId];
      const result = await runWarpRouteCheckFromRegistry({
        chains,
        multiProvider,
        registry,
        registryUris: registries,
        warpRouteId,
        warpCoreConfig: warpCoreConfigMap[warpRouteId],
        warpDeployConfig,
      });

      if (result.violations.length > 0) {
        logWarpRouteCheckResult(result);
        if (pushMetrics) {
          pushWarpViolationsMetrics(
            checkerViolationsGauge,
            result,
            warpRouteId,
          );
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

async function runWarpRouteCheckFromRegistry({
  multiProvider,
  warpRouteId,
  registryUris,
  registry,
  chains,
  warpCoreConfig,
  warpDeployConfig,
}: {
  chains?: string[];
  multiProvider: Awaited<ReturnType<EnvironmentConfig['getMultiProvider']>>;
  registry?: ReturnType<typeof getRegistry>;
  registryUris: string[];
  warpCoreConfig?: WarpCoreConfig;
  warpDeployConfig?: WarpRouteDeployConfigMailboxRequired;
  warpRouteId: string;
}): Promise<WarpRouteCheckResult> {
  const loadedConfigs = await loadWarpConfigsFromRegistry({
    registry,
    registryUris,
    warpRouteId,
    warpCoreConfig,
    warpDeployConfig,
  });

  const filteredConfigs = filterWarpConfigsByChains({
    chains,
    warpCoreConfig: loadedConfigs.warpCoreConfig,
    warpDeployConfig: loadedConfigs.warpDeployConfig,
  });

  return checkWarpRouteDeployConfig({
    multiProvider,
    warpCoreConfig: filteredConfigs.warpCoreConfig,
    warpDeployConfig: filteredConfigs.warpDeployConfig,
  });
}

function logWarpRouteCheckResult(result: WarpRouteCheckResult) {
  if (Object.keys(result.diff).length > 0) {
    console.log(chalk.yellow(yamlStringify(result.diff, null, 2)));
  }

  if (result.scaleViolations.length > 0) {
    console.log(
      chalk.red('Found invalid or missing scale for inconsistent decimals'),
    );
  }

  if (result.violations.length > 0) {
    console.table(result.violations, [
      'chain',
      'name',
      'type',
      'actual',
      'expected',
    ]);
  }
}

async function loadWarpConfigsFromRegistry({
  registry,
  registryUris,
  warpRouteId,
  warpCoreConfig,
  warpDeployConfig,
}: {
  registry?: ReturnType<typeof getRegistry>;
  registryUris: string[];
  warpRouteId: string;
  warpCoreConfig?: WarpCoreConfig;
  warpDeployConfig?: WarpRouteDeployConfigMailboxRequired;
}): Promise<{
  warpCoreConfig: WarpCoreConfig;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}> {
  const resolvedWarpCoreConfig =
    warpCoreConfig ??
    (await (
      registry ??
      getRegistry({
        registryUris,
        enableProxy: true,
      })
    ).getWarpRoute(warpRouteId));
  const resolvedWarpDeployConfig =
    warpDeployConfig ??
    (await getWarpDeployConfigFromMergedRegistry(warpRouteId, registryUris));

  assert(
    resolvedWarpCoreConfig,
    `Warp route config not found for ${warpRouteId}`,
  );
  assert(
    resolvedWarpDeployConfig,
    `Warp route deploy config not found for ${warpRouteId}`,
  );

  return {
    warpCoreConfig: resolvedWarpCoreConfig,
    warpDeployConfig: resolvedWarpDeployConfig,
  };
}

function filterWarpConfigsByChains({
  chains,
  warpCoreConfig,
  warpDeployConfig,
}: {
  chains?: string[];
  warpCoreConfig: WarpCoreConfig;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
}) {
  if (!chains?.length) {
    return { warpCoreConfig, warpDeployConfig };
  }

  const requestedChains = new Set(chains);
  const filteredWarpDeployConfig = objFilter(
    warpDeployConfig,
    (chain, _config): _config is WarpRouteDeployConfigMailboxRequired[string] =>
      requestedChains.has(chain),
  );
  const matchingWarpCoreTokens = warpCoreConfig.tokens.filter((token) =>
    requestedChains.has(token.chainName),
  );

  assert(
    matchingWarpCoreTokens.length > 0,
    `None of the requested chains are present in the warp core config: ${chains.join(', ')}`,
  );
  assert(
    Object.keys(filteredWarpDeployConfig).length > 0,
    `None of the requested chains are present in the warp deploy config: ${chains.join(', ')}`,
  );

  return {
    // Keep the full core config so expected remote router sets are preserved
    // for the selected route members.
    warpCoreConfig,
    warpDeployConfig: filteredWarpDeployConfig,
  };
}

async function getWarpIdsToCheck({
  environment,
  envConfig,
  registry,
  registryWarpDeployConfigMap,
}: {
  environment: string;
  envConfig: ReturnType<typeof getEnvironmentConfig>;
  registry: ReturnType<typeof getRegistry>;
  registryWarpDeployConfigMap: Record<
    string,
    WarpRouteDeployConfigMailboxRequired
  >;
}) {
  const warpRouteIds = Object.keys(registryWarpDeployConfigMap);
  const routesWithUnsupportedChains: string[] = [];

  const filterResults = await Promise.all(
    warpRouteIds.map(async (warpRouteId) => {
      const warpRouteConfig = registryWarpDeployConfigMap[warpRouteId];
      const isTestnet = await isTestnetRoute(registry, warpRouteConfig);
      const shouldCheck =
        (environment === 'mainnet3' && !isTestnet) ||
        (environment === 'testnet4' && isTestnet);

      if (!shouldCheck || ROUTES_TO_SKIP.includes(warpRouteId)) {
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

  return {
    routesWithUnsupportedChains,
    warpIdsToCheck: warpRouteIds.filter((_, index) => filterResults[index]),
  };
}

function logUnsupportedRoutes(routesWithUnsupportedChains: string[]) {
  if (routesWithUnsupportedChains.length === 0) {
    return;
  }

  console.log(
    chalk.yellow(
      `Skipping ${routesWithUnsupportedChains.length} routes with unsupported chains:`,
    ),
  );
  routesWithUnsupportedChains.forEach((route) =>
    console.log(chalk.yellow(`  - ${route}`)),
  );
}

function getWarpConfigChains({
  warpCoreConfigMap,
  warpDeployConfigMap,
  warpRouteIds,
}: {
  warpCoreConfigMap: Record<string, WarpCoreConfig>;
  warpDeployConfigMap: Record<string, WarpRouteDeployConfigMailboxRequired>;
  warpRouteIds: string[];
}) {
  const warpConfigChains = new Set<ChainName>();
  warpRouteIds.forEach((warpRouteId) => {
    const warpDeployConfig = warpDeployConfigMap[warpRouteId];
    Object.keys(warpDeployConfig).forEach((chain) =>
      warpConfigChains.add(chain),
    );
    warpCoreConfigMap[warpRouteId].tokens.forEach((token) =>
      warpConfigChains.add(token.chainName),
    );
  });
  return warpConfigChains;
}

async function getWarpConfigsToCheck({
  envConfig,
  getterInputsMultiProvider,
  registry,
  registryUris,
  registryWarpDeployConfigMap,
  warpConfigGetterInputs,
  warpRouteIds,
}: {
  envConfig: ReturnType<typeof getEnvironmentConfig>;
  getterInputsMultiProvider: MultiProvider;
  registry: ReturnType<typeof getRegistry>;
  registryUris: string[];
  registryWarpDeployConfigMap: Record<
    string,
    WarpRouteDeployConfigMailboxRequired
  >;
  warpConfigGetterInputs: Awaited<ReturnType<typeof getWarpConfigGetterInputs>>;
  warpRouteIds: string[];
}) {
  const loadResults = await Promise.all(
    warpRouteIds.map(async (warpRouteId) => {
      try {
        const warpCoreConfig = await registry.getWarpRoute(warpRouteId);
        assert(
          warpCoreConfig,
          `Warp route config not found for ${warpRouteId}`,
        );

        const warpDeployConfig = warpConfigGetterMap[warpRouteId]
          ? WarpRouteDeployConfigMailboxRequiredSchema.parse(
              await getWarpConfig(
                getterInputsMultiProvider,
                envConfig,
                warpRouteId,
                registryUris,
                false,
                warpConfigGetterInputs,
              ),
            )
          : registryWarpDeployConfigMap[warpRouteId];

        const requiredChains = new Set([
          ...Object.keys(warpDeployConfig),
          ...warpCoreConfig.tokens.map((token) => token.chainName),
        ]);
        const unsupportedChains = Array.from(requiredChains).filter(
          (chain) => !envConfig.supportedChainNames.includes(chain),
        );

        return {
          unsupportedChains,
          warpCoreConfig,
          warpDeployConfig,
          warpRouteId,
        };
      } catch (error) {
        return {
          error,
          warpRouteId,
        };
      }
    }),
  );

  const routesWithUnsupportedChains: string[] = [];
  const failedWarpRouteConfigLoads: string[] = [];
  const warpDeployConfigMap: Record<
    string,
    WarpRouteDeployConfigMailboxRequired
  > = {};
  const warpCoreConfigMap: Record<string, WarpCoreConfig> = {};

  for (const result of loadResults) {
    if ('error' in result) {
      console.error(
        chalk.red(
          `Error loading warp config for ${result.warpRouteId}: ${result.error}`,
        ),
      );
      failedWarpRouteConfigLoads.push(result.warpRouteId);
      continue;
    }

    if (result.unsupportedChains.length > 0) {
      routesWithUnsupportedChains.push(
        `${result.warpRouteId} (${result.unsupportedChains.join(', ')})`,
      );
      continue;
    }

    warpDeployConfigMap[result.warpRouteId] = result.warpDeployConfig;
    warpCoreConfigMap[result.warpRouteId] = result.warpCoreConfig;
  }

  return {
    failedWarpRouteConfigLoads,
    routesWithUnsupportedChains,
    warpCoreConfigMap,
    warpDeployConfigMap,
  };
}

async function isTestnetRoute(
  registry: ReturnType<typeof getRegistry>,
  warpRouteConfig: WarpRouteDeployConfigMailboxRequired,
) {
  for (const chain of Object.keys(warpRouteConfig)) {
    const chainMetadata = await registry.getChainMetadata(chain);
    if (chainMetadata?.isTestnet) {
      return true;
    }
  }
  return false;
}

function pushWarpViolationsMetrics(
  checkerViolationsGauge: Gauge<string>,
  result: WarpRouteCheckResult,
  warpRouteId: string,
) {
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
