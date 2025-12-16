#!/usr/bin/env node
/**
 * Hyperlane Rebalancer Service Entry Point
 *
 * This is the main entry point for running the rebalancer as a standalone service
 * in Kubernetes or other container environments. It reads configuration from
 * environment variables and files, then starts the rebalancer in daemon mode.
 *
 * Environment Variables:
 * - REBALANCER_CONFIG_FILE: Path to the rebalancer configuration YAML file (required)
 * - HYP_KEY: Private key for signing transactions (required)
 * - COINGECKO_API_KEY: API key for CoinGecko price fetching (optional, for metrics)
 * - CHECK_FREQUENCY: Balance check frequency in ms (default: 60000)
 * - WITH_METRICS: Enable Prometheus metrics (default: "true")
 * - MONITOR_ONLY: Run in monitor-only mode without executing transactions (default: "false")
 * - LOG_LEVEL: Logging level (default: "info") - supported by pino
 * - REGISTRY_URI: Registry URI for chain metadata. Can include /tree/{commit} to pin version (default: GitHub registry)
 *
 * Usage:
 *   node dist/service.js
 *   REBALANCER_CONFIG_FILE=/config/rebalancer.yaml HYP_KEY=0x... node dist/service.js
 */
import { Wallet } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProtocolProvider, MultiProvider } from '@hyperlane-xyz/sdk';
import { createServiceLogger, rootLogger } from '@hyperlane-xyz/utils';

import { RebalancerConfig } from './config/RebalancerConfig.js';
import { RebalancerService } from './core/RebalancerService.js';

function getVersion(): string {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'),
    );
    return packageJson.version;
  } catch (error) {
    rootLogger.warn({ error }, 'Could not read version from package.json');
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const VERSION = getVersion();
  // Validate required environment variables
  const configFile = process.env.REBALANCER_CONFIG_FILE;
  if (!configFile) {
    rootLogger.error('REBALANCER_CONFIG_FILE environment variable is required');
    process.exit(1);
  }

  const privateKey = process.env.HYP_KEY;
  if (!privateKey) {
    rootLogger.error('HYP_KEY environment variable is required');
    process.exit(1);
  }

  // Parse optional environment variables
  let checkFrequency = 60_000;
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

  const withMetrics = process.env.WITH_METRICS !== 'false';
  const monitorOnly = process.env.MONITOR_ONLY === 'true';
  const coingeckoApiKey = process.env.COINGECKO_API_KEY;

  // Create logger (uses LOG_LEVEL environment variable for level configuration)
  const logger = await createServiceLogger({
    service: 'rebalancer',
    version: VERSION,
  });

  logger.info(
    {
      version: VERSION,
      configFile,
      checkFrequency,
      withMetrics,
      monitorOnly,
    },
    'Starting Hyperlane Rebalancer Service',
  );

  try {
    // Load rebalancer configuration
    const rebalancerConfig = RebalancerConfig.load(configFile);
    logger.info('✅ Loaded rebalancer configuration');

    // Initialize registry (uses env var or defaults to GitHub registry)
    // For GitHub registries, REGISTRY_URI can include /tree/{commit} to pin to a specific version
    const registryUri = process.env.REGISTRY_URI || DEFAULT_GITHUB_REGISTRY;
    const registry = getRegistry({
      registryUris: [registryUri],
      enableProxy: true,
      logger: rootLogger,
    });
    logger.info({ registryUri }, '✅ Initialized registry');

    // Get chain metadata from registry
    const chainMetadata = await registry.getMetadata();
    logger.info(
      `✅ Loaded metadata for ${Object.keys(chainMetadata).length} chains`,
    );

    // Create MultiProvider with signer
    const multiProvider = new MultiProvider(chainMetadata);
    const signer = new Wallet(privateKey);
    multiProvider.setSharedSigner(signer);
    logger.info('✅ Initialized MultiProvider with signer');

    // Create MultiProtocolProvider
    const multiProtocolProvider = new MultiProtocolProvider(chainMetadata);
    logger.info('✅ Initialized MultiProtocolProvider');

    // Create the rebalancer service
    const service = new RebalancerService(
      multiProvider,
      multiProtocolProvider,
      registry,
      rebalancerConfig,
      {
        mode: 'daemon',
        checkFrequency,
        monitorOnly,
        withMetrics,
        coingeckoApiKey,
        logger,
        version: VERSION,
      },
    );

    // Start the service
    await service.start();
  } catch (error) {
    logger.error({ error }, 'Failed to start rebalancer service');
    process.exit(1);
  }
}

// Run the service
main().catch((error) => {
  rootLogger.error({ error }, 'Fatal error');
  process.exit(1);
});
