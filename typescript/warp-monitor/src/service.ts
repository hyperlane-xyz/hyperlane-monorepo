#!/usr/bin/env node
/**
 * Hyperlane Warp Monitor Service Entry Point
 *
 * This is the main entry point for running the warp balance monitor as a standalone service
 * in Kubernetes or other container environments. It reads configuration from
 * environment variables, then starts the monitor in daemon mode.
 *
 * It runs in one of two modes:
 * - Single-route (legacy): set WARP_ROUTE_ID to monitor exactly one route.
 * - Centralized: set WARP_ROUTE_IDS (comma-separated) or WARP_ROUTE_ALL=true to
 *   monitor many routes from one process, sharing chain providers and one
 *   metrics server.
 *
 * Environment Variables:
 * - WARP_ROUTE_ID: Single route to monitor (single-route mode)
 * - WARP_ROUTE_IDS: Comma-separated route IDs to monitor (centralized mode)
 * - WARP_ROUTE_ALL: If "true", monitor every route in the registry (centralized mode)
 * - WARP_MONITOR_CONCURRENCY: Max routes processed concurrently per cycle (centralized, default: 10)
 * - SKIP_SHARED_BALANCE_WARP_ROUTE_IDS: Comma-separated route IDs whose shared balance
 *     metrics are already emitted by a rebalancer and must not be double-emitted
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
 */
import {
  DEFAULT_GITHUB_REGISTRY,
  type IRegistry,
} from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_EXPLORER_QUERY_LIMIT } from './constants.js';
import { MultiWarpMonitor } from './multi-monitor.js';
import { WarpMonitor } from './monitor.js';
import { initializeLogger } from './utils.js';

const DEFAULT_CONCURRENCY = 10;

function parsePositiveInt(
  value: string | undefined,
  name: string,
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

function parseIdList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

async function resolveWarpRouteIds(registry: IRegistry): Promise<string[]> {
  const warpRoutes = await registry.getWarpRoutes();
  return Object.keys(warpRoutes);
}

async function main(): Promise<void> {
  const VERSION = process.env.SERVICE_VERSION ?? 'dev';

  const warpRouteId = process.env.WARP_ROUTE_ID;
  const warpRouteIds = parseIdList(process.env.WARP_ROUTE_IDS);
  const warpRouteAll = process.env.WARP_ROUTE_ALL === 'true';
  const centralized = warpRouteAll || warpRouteIds.length > 0;

  if (!centralized && !warpRouteId) {
    rootLogger.error(
      'Provide WARP_ROUTE_ID (single) or WARP_ROUTE_IDS / WARP_ROUTE_ALL (centralized)',
    );
    process.exit(1);
  }

  // Parse optional environment variables shared by both modes
  const checkFrequency = parsePositiveInt(
    process.env.CHECK_FREQUENCY,
    'CHECK_FREQUENCY',
    30_000,
  );
  const explorerQueryLimit = parsePositiveInt(
    process.env.EXPLORER_QUERY_LIMIT,
    'EXPLORER_QUERY_LIMIT',
    DEFAULT_EXPLORER_QUERY_LIMIT,
  );
  const coingeckoApiKey = process.env.COINGECKO_API_KEY;
  const explorerApiUrl = process.env.EXPLORER_API_URL;
  const inventoryAddress = process.env.INVENTORY_ADDRESS;

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

    if (centralized) {
      const concurrency = parsePositiveInt(
        process.env.WARP_MONITOR_CONCURRENCY,
        'WARP_MONITOR_CONCURRENCY',
        DEFAULT_CONCURRENCY,
      );
      const skipSharedBalanceWarpRouteIds = new Set(
        parseIdList(process.env.SKIP_SHARED_BALANCE_WARP_ROUTE_IDS),
      );
      const resolvedIds = warpRouteAll
        ? await resolveWarpRouteIds(registry)
        : warpRouteIds;

      logger.info(
        {
          version: VERSION,
          mode: 'centralized',
          routeCount: resolvedIds.length,
          warpRouteAll,
          concurrency,
          checkFrequency,
          explorerApiUrl,
          explorerQueryLimit,
          inventoryAddress,
          skipSharedBalanceCount: skipSharedBalanceWarpRouteIds.size,
        },
        'Starting Hyperlane Warp Balance Monitor Service',
      );

      const monitor = new MultiWarpMonitor(
        {
          warpRouteIds: resolvedIds,
          checkFrequency,
          concurrency,
          coingeckoApiKey,
          explorerApiUrl,
          explorerQueryLimit,
          inventoryAddress,
          skipSharedBalanceWarpRouteIds,
        },
        registry,
      );
      await monitor.start();
      return;
    }

    if (!warpRouteId) {
      // Unreachable: the early guard rejects this, but this narrows the type.
      logger.error('WARP_ROUTE_ID environment variable is required');
      process.exit(1);
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
