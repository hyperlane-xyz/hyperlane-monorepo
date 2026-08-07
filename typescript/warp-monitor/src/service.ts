#!/usr/bin/env node
/**
 * Hyperlane Warp Monitor Service Entry Point
 *
 * This is the main entry point for running the warp balance monitor as a standalone service
 * in Kubernetes or other container environments. It reads configuration from
 * environment variables, then starts the monitor in daemon mode.
 *
 * Modes:
 * - Single-route (legacy): set WARP_ROUTE_ID to monitor one route per process.
 * - Centralized (multi-route): set WARP_ROUTE_IDS (comma-separated) or
 *   WARP_ROUTE_ALL=true to monitor many routes from one process.
 *
 * Environment Variables:
 * - WARP_ROUTE_ID: Single route ID to monitor (single-route mode).
 * - WARP_ROUTE_IDS: Comma-separated route IDs to monitor (centralized mode).
 * - WARP_ROUTE_ALL: When "true", monitor every route in the registry (centralized mode).
 * - WARP_MONITOR_CONCURRENCY: Max routes processed concurrently per cycle (centralized mode, default: 10)
 * - SKIP_SHARED_BALANCE_WARP_ROUTE_IDS: Comma-separated route IDs whose shared
 *     balance metrics are owned by another workload (e.g. a rebalancer) and
 *     should not be re-emitted (centralized mode, optional).
 * - CHECK_FREQUENCY: Balance check frequency in ms (default: 30000)
 * - COINGECKO_API_KEY: API key for CoinGecko price fetching (optional)
 * - LOG_LEVEL: Logging level (default: "info") - supported by pino
 * - REGISTRY_URI: Registry URI for chain metadata. Can include /tree/{commit} to pin version (default: GitHub registry)
 * - RPC_URL_<CHAIN>: Override RPC URL for a specific chain (e.g., RPC_URL_ETHEREUM, RPC_URL_ARBITRUM)
 * - EXPLORER_API_URL: Hyperlane explorer GraphQL endpoint for pending transfer liabilities (optional)
 * - EXPLORER_QUERY_LIMIT: Max pending transfer rows fetched per cycle (default: 200)
 * - INVENTORY_ADDRESS: Address whose per-node inventory balances should be tracked (optional)
 *
 * Usage:
 *   node dist/service.js
 *   WARP_ROUTE_ID=ETH/ethereum-base COINGECKO_API_KEY=... node dist/service.js
 *   WARP_ROUTE_ALL=true node dist/service.js
 *   WARP_ROUTE_IDS=ETH/ethereum-base,USDC/eni node dist/service.js
 */
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { WarpMonitor } from './monitor.js';
import { MultiWarpMonitor } from './multi-monitor.js';
import { initializeLogger } from './utils.js';

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePositiveIntEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    rootLogger.error(`${name} must be a positive integer`);
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const VERSION = process.env.SERVICE_VERSION ?? 'dev';

  const warpRouteId = process.env.WARP_ROUTE_ID;
  const explicitRouteIds = parseCsvEnv(process.env.WARP_ROUTE_IDS);
  const monitorAllRoutes = process.env.WARP_ROUTE_ALL === 'true';
  const isCentralized = monitorAllRoutes || explicitRouteIds.length > 0;

  if (!isCentralized && !warpRouteId) {
    rootLogger.error(
      'One of WARP_ROUTE_ID, WARP_ROUTE_IDS, or WARP_ROUTE_ALL=true is required',
    );
    process.exit(1);
  }

  const checkFrequency = parsePositiveIntEnv(
    'CHECK_FREQUENCY',
    process.env.CHECK_FREQUENCY,
    30_000,
  );
  const explorerQueryLimit = parsePositiveIntEnv(
    'EXPLORER_QUERY_LIMIT',
    process.env.EXPLORER_QUERY_LIMIT,
    200,
  );
  const concurrency = parsePositiveIntEnv(
    'WARP_MONITOR_CONCURRENCY',
    process.env.WARP_MONITOR_CONCURRENCY,
    10,
  );

  const coingeckoApiKey = process.env.COINGECKO_API_KEY;
  const explorerApiUrl = process.env.EXPLORER_API_URL;
  const inventoryAddress = process.env.INVENTORY_ADDRESS;
  const skipSharedBalanceRouteIds = new Set(
    parseCsvEnv(process.env.SKIP_SHARED_BALANCE_WARP_ROUTE_IDS),
  );

  // Create logger (uses LOG_LEVEL environment variable for level configuration)
  const logger = await initializeLogger('warp-balance-monitor', VERSION);

  try {
    // Initialize registry (uses env var or defaults to GitHub registry)
    // For GitHub registries, REGISTRY_URI can include /tree/{commit} to pin to a specific version
    const registryUri = process.env.REGISTRY_URI ?? DEFAULT_GITHUB_REGISTRY;
    const registry = getRegistry({
      registryUris: [registryUri],
      enableProxy: true,
      logger: rootLogger,
    });
    logger.info({ registryUri }, 'Initialized registry');

    if (isCentralized) {
      logger.info(
        {
          version: VERSION,
          mode: 'centralized',
          monitorAllRoutes,
          explicitRouteCount: explicitRouteIds.length,
          concurrency,
          skipSharedBalanceRouteCount: skipSharedBalanceRouteIds.size,
          checkFrequency,
        },
        'Starting Hyperlane Warp Balance Monitor Service (centralized)',
      );

      const monitor = new MultiWarpMonitor(
        {
          warpRouteIds: monitorAllRoutes ? undefined : explicitRouteIds,
          checkFrequency,
          coingeckoApiKey,
          registryUri,
          explorerApiUrl,
          explorerQueryLimit,
          inventoryAddress,
          concurrency,
          skipSharedBalanceRouteIds,
        },
        registry,
      );

      await monitor.start();
      return;
    }

    logger.info(
      {
        version: VERSION,
        mode: 'single',
        warpRouteId,
        checkFrequency,
        explorerApiUrl,
        explorerQueryLimit,
        inventoryAddress,
      },
      'Starting Hyperlane Warp Balance Monitor Service',
    );

    assert(warpRouteId, 'WARP_ROUTE_ID is required in single-route mode');

    // Create and start the monitor
    const monitor = new WarpMonitor(
      {
        warpRouteId,
        checkFrequency,
        coingeckoApiKey,
        registryUri,
        explorerApiUrl,
        explorerQueryLimit,
        inventoryAddress,
      },
      registry,
    );

    await monitor.start();
  } catch (error) {
    logger.error({ error }, 'Failed to start warp monitor service');
    process.exit(1);
  }
}

// Run the service
main().catch((error) => {
  rootLogger.error({ error }, 'Fatal error');
  process.exit(1);
});
