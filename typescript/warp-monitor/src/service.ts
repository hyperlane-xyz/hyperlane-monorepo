#!/usr/bin/env node
/**
 * Hyperlane Warp Monitor Service Entry Point
 *
 * This is the main entry point for running the warp balance monitor as a standalone service
 * in Kubernetes or other container environments. It reads configuration from
 * environment variables, then starts the monitor in daemon mode.
 *
 * Environment Variables:
 * - WARP_ROUTE_ID: The warp route ID to monitor (required)
 * - CHECK_FREQUENCY: Balance check frequency in ms (default: 30000)
 * - COINGECKO_API_KEY: API key for CoinGecko price fetching (optional)
 * - LOG_LEVEL: Logging level (default: "info") - supported by pino
 * - REGISTRY_URI: Registry URI for chain metadata. Can include /tree/{commit} to pin version (default: GitHub registry)
 * - RPC_URL_<CHAIN>: Override RPC URL for a specific chain (e.g., RPC_URL_ETHEREUM, RPC_URL_ARBITRUM)
 * - EXPLORER_API_URL: Hyperlane explorer GraphQL endpoint for pending transfer liabilities (optional)
 * - EXPLORER_QUERY_LIMIT: Max pending transfer rows fetched per cycle (default: 200)
 * - INVENTORY_ADDRESS: Address whose per-node inventory balances should be tracked (optional)
 * - DUST_AMOUNT: Default native amount to send to recipients that lack gas on supported destination chains (optional)
 * - DUST_AMOUNT_<CHAIN>: Per-chain override for DUST_AMOUNT, for example DUST_AMOUNT_BASE (optional)
 * - DUST_MAX_RECIPIENT_BALANCE: Skip dusting recipients whose native balance is above this amount (default: 0)
 * - DUST_SOURCE_CHAINS: Comma-separated allowlist of source chains to watch for SentTransferRemote events (optional)
 * - DUST_DESTINATION_CHAINS: Comma-separated allowlist of destination chains eligible for dusting (optional)
 * - DUST_EVENT_LOOKBACK_BLOCKS: Initial EVM event lookback window when the duster starts (default: 64)
 * - HYP_KEY: Private key used for sending dust on supported destination chains when dusting is enabled
 *
 * The initial dusting implementation watches EVM-origin SentTransferRemote events and
 * sends dust on supported destination chains that can be funded with HYP_KEY-backed signers.
 *
 * Usage:
 *   node dist/service.js
 *   WARP_ROUTE_ID=ETH/ethereum-base COINGECKO_API_KEY=... node dist/service.js
 */
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { rootLogger } from '@hyperlane-xyz/utils';

import { WarpTransferDuster } from './duster.js';
import { WarpMonitor } from './monitor.js';
import type { WarpNativeDustConfig } from './types.js';
import { initializeLogger } from './utils.js';

async function main(): Promise<void> {
  const VERSION = process.env.SERVICE_VERSION || 'dev';

  // Validate required environment variables
  const warpRouteId = process.env.WARP_ROUTE_ID;
  if (!warpRouteId) {
    rootLogger.error('WARP_ROUTE_ID environment variable is required');
    process.exit(1);
  }

  // Parse optional environment variables
  let checkFrequency = 30_000;
  if (process.env.CHECK_FREQUENCY) {
    const parsed = parseInt(process.env.CHECK_FREQUENCY, 10);
    if (isNaN(parsed) || parsed <= 0) {
      rootLogger.error(
        'CHECK_FREQUENCY must be a positive number (milliseconds)',
      );
      process.exit(1);
    }
    checkFrequency = parsed;
  }

  const coingeckoApiKey = process.env.COINGECKO_API_KEY;
  const explorerApiUrl = process.env.EXPLORER_API_URL;
  const inventoryAddress = process.env.INVENTORY_ADDRESS;
  const nativeDusting = parseNativeDustingConfigFromEnv();

  let explorerQueryLimit = 200;
  if (process.env.EXPLORER_QUERY_LIMIT) {
    const parsed = Number(process.env.EXPLORER_QUERY_LIMIT);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      rootLogger.error('EXPLORER_QUERY_LIMIT must be a positive integer');
      process.exit(1);
    }
    explorerQueryLimit = parsed;
  }

  // Create logger (uses LOG_LEVEL environment variable for level configuration)
  const logger = await initializeLogger('warp-balance-monitor', VERSION);

  logger.info(
    {
      version: VERSION,
      warpRouteId,
      checkFrequency,
      explorerApiUrl,
      explorerQueryLimit,
      inventoryAddress,
      nativeDustingEnabled: !!nativeDusting,
    },
    'Starting Hyperlane Warp Balance Monitor Service',
  );

  try {
    // Initialize registry (uses env var or defaults to GitHub registry)
    // For GitHub registries, REGISTRY_URI can include /tree/{commit} to pin to a specific version
    const registryUri = process.env.REGISTRY_URI || DEFAULT_GITHUB_REGISTRY;
    const registry = getRegistry({
      registryUris: [registryUri],
      enableProxy: true,
      logger: rootLogger,
    });
    logger.info({ registryUri }, 'Initialized registry');

    // Create and start the monitor
    const config = {
      warpRouteId,
      checkFrequency,
      coingeckoApiKey,
      registryUri,
      explorerApiUrl,
      explorerQueryLimit,
      inventoryAddress,
      nativeDusting,
    };

    const monitor = new WarpMonitor(config, registry);
    const duster = nativeDusting
      ? new WarpTransferDuster(config, registry)
      : undefined;

    const services = [monitor.start()];
    if (duster) services.push(duster.start());
    await Promise.all(services);
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

function parseNativeDustingConfigFromEnv(): WarpNativeDustConfig | undefined {
  const defaultAmount = process.env.DUST_AMOUNT;
  if (!defaultAmount) return undefined;

  const privateKey = process.env.HYP_KEY;
  if (!privateKey) {
    rootLogger.error(
      'HYP_KEY environment variable is required when DUST_AMOUNT is set',
    );
    process.exit(1);
  }

  const amountByChain = Object.entries(process.env)
    .filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith('DUST_AMOUNT_') &&
        typeof entry[1] === 'string' &&
        entry[1].length > 0,
    )
    .reduce<Record<string, string>>((acc, [key, value]) => {
      const chain = key
        .replace('DUST_AMOUNT_', '')
        .toLowerCase()
        .replaceAll('_', '-');
      acc[chain] = value;
      return acc;
    }, {});

  return {
    privateKey,
    defaultAmount,
    amountByChain: Object.keys(amountByChain).length
      ? amountByChain
      : undefined,
    maxRecipientBalance: process.env.DUST_MAX_RECIPIENT_BALANCE,
    sourceChains: parseCsvEnv(process.env.DUST_SOURCE_CHAINS),
    destinationChains: parseCsvEnv(process.env.DUST_DESTINATION_CHAINS),
    eventLookbackBlocks: parsePositiveIntegerEnv(
      'DUST_EVENT_LOOKBACK_BLOCKS',
      process.env.DUST_EVENT_LOOKBACK_BLOCKS,
      64,
    ),
  };
}

function parseCsvEnv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length ? parsed : undefined;
}

function parsePositiveIntegerEnv(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    rootLogger.error(`${name} must be a positive integer`);
    process.exit(1);
  }
  return parsed;
}
