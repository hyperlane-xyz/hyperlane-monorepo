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
  warpViolationGroupings,
} from './check-utils.js';

const ROUTES_TO_SKIP: string[] = [
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
  // Staging route: not auto-skipped by isStagingOrTestRoute since the STAGE
  // marker is in the symbol before the first `/`, not a chain segment.
  WarpRouteIds.EclipseUSDCSTAGE,
];

// Name segments that mark a warp route as a non-production (staging/test)
// deployment. Matched against the `-`/`/`-delimited segments of the route
// name so `USDC/moonpay-staging` is skipped but names like `attestation` are
// not. These routes are excluded from check-warp-deploy so they don't produce
// violations on mainnet.
const STAGING_ROUTE_MARKERS = ['staging', 'test'];

// Token-symbol suffixes that mark a route as staging, e.g. `USDCSTAGE`,
// `HYPERSTAGE`, `REZSTAGING`. The staging marker is fused onto the symbol
// (before the first `/`) rather than living in its own chain segment, so it is
// not caught by STAGING_ROUTE_MARKERS above.
const STAGING_SYMBOL_SUFFIXES = ['stage', 'staging'];

function isStagingOrTestRoute(warpRouteId: string): boolean {
  const [symbol = '', ...rest] = warpRouteId.split('/');
  const lowerSymbol = symbol.toLowerCase();
  if (STAGING_SYMBOL_SUFFIXES.some((suffix) => lowerSymbol.endsWith(suffix))) {
    return true;
  }
  const segments = rest.join('/').toLowerCase().split(/[-/]/);
  return segments.some((segment) => STAGING_ROUTE_MARKERS.includes(segment));
}

interface OwnerStatusSkip {
  warpRouteId: string;
  chain: string;
  // Optional: when set, only the ownerStatus violation for this exact owner is
  // skipped; when omitted, any ownerStatus violation on the route+chain is.
  owner?: string;
}

// Legacy warp routes whose owner on a given chain is intentionally an inactive
// EOA (nonce 0, no code) rather than a live account or Safe. The ownerStatus
// virtual check maps any Inactive owner to expected=Active (see
// expandWarpDeployConfig in configUtils.ts), so these routes emit a permanent
// ConfigMismatch that cannot be resolved without a live ownership migration.
// Allowlist the specific {route, chain, owner} so ONLY that ownerStatus
// violation is suppressed — every other check on the route still runs.
const OWNER_STATUS_SKIP: OwnerStatusSkip[] = [
  {
    warpRouteId: 'BEST/ethereum',
    chain: 'bsc',
    owner: '0x081Ec7bf32dEf8730DABc19dBA69a6E86dC0Ae2E',
  },
  {
    warpRouteId: 'BEST/ethereum',
    chain: 'ethereum',
    owner: '0x081Ec7bf32dEf8730DABc19dBA69a6E86dC0Ae2E',
  },
  {
    warpRouteId: 'GNET/galactica',
    chain: 'galactica',
    owner: '0xFe758b0Bc6aA63Ff0Db876F3ed38204a2e413060',
  },
  {
    warpRouteId: 'USDC/coti-ethereum',
    chain: 'coti',
    owner: '0xdF2E2886d23ba57F996C203D2Ccd9dCa6373590C',
  },
  {
    warpRouteId: 'WBTC/coti-ethereum',
    chain: 'coti',
    owner: '0xdF2E2886d23ba57F996C203D2Ccd9dCa6373590C',
  },
  {
    warpRouteId: 'USDT/eclipsemainnet',
    chain: 'tron',
  },
];

// ownerStatus virtual-config violations carry a field path of the form
// `ownerStatus.<ownerAddress>`, so match on that prefix plus the allowlisted
// route/chain/owner.
function isSkippedOwnerStatusViolation(
  warpRouteId: string,
  violation: { chain: string; name: string },
): boolean {
  if (!violation.name.toLowerCase().includes('ownerstatus')) {
    return false;
  }
  const violationName = violation.name.toLowerCase();
  return OWNER_STATUS_SKIP.some(
    (skip) =>
      skip.warpRouteId === warpRouteId &&
      skip.chain === violation.chain &&
      (skip.owner === undefined ||
        violationName.includes(skip.owner.toLowerCase())),
  );
}

// Upper bound on how long a single warp route check may run before it is
// abandoned. A hung/unresponsive RPC leg on one route would otherwise stall the
// entire cron run indefinitely, starving every subsequent route of a check.
const DEFAULT_PER_ROUTE_TIMEOUT_MS = 5 * 60 * 1000;
const perRouteTimeoutMs = Number(
  process.env.WARP_CHECK_PER_ROUTE_TIMEOUT_MS ?? DEFAULT_PER_ROUTE_TIMEOUT_MS,
);

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeoutMessage: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(onTimeoutMessage)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function main() {
  const { environment, chains, pushMetrics } =
    await getCheckWarpDeployArgs().argv;

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
      const result = await withTimeout(
        runWarpRouteCheckFromRegistry({
          chains,
          multiProvider,
          registry,
          registryUris: registries,
          warpRouteId,
          warpCoreConfig: warpCoreConfigMap[warpRouteId],
          warpDeployConfig,
        }),
        perRouteTimeoutMs,
        `Timed out checking warp route ${warpRouteId} after ${perRouteTimeoutMs}ms`,
      );

      result.violations = result.violations.filter(
        (violation) => !isSkippedOwnerStatusViolation(warpRouteId, violation),
      );

      if (result.violations.length > 0) {
        logWarpRouteCheckResult(result);
        if (pushMetrics) {
          await pushWarpViolationsMetrics(result, warpRouteId, environment);
        }
      } else {
        console.info(chalk.green(`warp checker found no violations`));
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

      if (
        !shouldCheck ||
        ROUTES_TO_SKIP.includes(warpRouteId) ||
        isStagingOrTestRoute(warpRouteId)
      ) {
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

// Each violation is pushed to PushGateway under its own group, keyed by an
// alert_key grouping label. This makes every violation an independently
// addressable series that can be cleared on its own (DELETE / push 0) without
// touching any other violation. We do NOT overwrite the whole job group: a run
// that does not observe a given violation must leave that series untouched, so
// stale RPCs or a partial run can never silently auto-clear a real alert.
// Clearing is exclusively the human-confirmed action (see clear-warp-violation).
async function pushWarpViolationsMetrics(
  result: WarpRouteCheckResult,
  warpRouteId: string,
  environment: string,
) {
  for (const violation of result.violations) {
    const register = new Registry();
    const gauge = new Gauge(getCheckerViolationsGaugeObj(register));
    register.registerMetric(gauge);
    gauge
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

    const groupings = warpViolationGroupings(
      warpRouteId,
      violation.chain,
      violation.name,
      violation.type,
    );

    // PUT (overwriteAllMetrics) is safe here because this group holds exactly
    // one series; it keeps the single-series group clean across refreshes.
    await submitMetrics(register, `check-warp-deploy-${environment}`, {
      groupings,
      overwriteAllMetrics: true,
    });
    console.log(
      `Violation: ${violation.name} on ${violation.chain} with ${violation.actual} ${violation.type} ${violation.expected} pushed to metrics`,
    );
  }
}
