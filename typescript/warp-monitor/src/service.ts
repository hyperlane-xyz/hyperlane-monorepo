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
 *
 * Usage:
 *   node dist/service.js
 *   WARP_ROUTE_ID=ETH/ethereum-base COINGECKO_API_KEY=... node dist/service.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { rootLogger } from '@hyperlane-xyz/utils';

import { WarpMonitor } from './monitor.js';
import { initializeLogger } from './utils.js';

function getVersion(): string {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'),
    );
    return packageJson.version;
  } catch {
    rootLogger.warn('Could not read version from package.json');
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const VERSION = getVersion();

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

  // Create logger (uses LOG_LEVEL environment variable for level configuration)
  const logger = await initializeLogger('warp-balance-monitor', VERSION);

  logger.info(
    {
      version: VERSION,
      warpRouteId,
      checkFrequency,
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
    const monitor = new WarpMonitor(
      {
        warpRouteId,
        checkFrequency,
        coingeckoApiKey,
        registryUri,
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
