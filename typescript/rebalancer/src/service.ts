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
 * - HYP_REBALANCER_KEY: Private key for movable collateral rebalancing operations (preferred)
 * - HYP_KEY: Fallback private key for HYP_REBALANCER_KEY (optional)
 * - HYP_INVENTORY_KEY: Private key for inventory operations - LiFi bridges and transferRemote (optional)
 * - COINGECKO_API_KEY: API key for CoinGecko price fetching (optional, for metrics)
 * - CHECK_FREQUENCY: Balance check frequency in ms (default: 60000)
 * - WITH_METRICS: Enable Prometheus metrics (default: "true")
 * - MONITOR_ONLY: Run in monitor-only mode without executing transactions (default: "false")
 * - LOG_LEVEL: Logging level (default: "info") - supported by pino
 * - REGISTRY_URI: Registry URI for chain metadata. Can include /tree/{commit} to pin version (default: GitHub registry)
 * - RPC_URL_<CHAIN>: Override RPC URL for a specific chain (e.g., RPC_URL_ETHEREUM, RPC_URL_ARBITRUM)
 *
 * Usage:
 *   node dist/service.js
 *   REBALANCER_CONFIG_FILE=/config/rebalancer.yaml HYP_REBALANCER_KEY=0x... HYP_INVENTORY_KEY=0x... node dist/service.js
 */
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  LocalAccountViemSigner,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import {
  applyRpcUrlOverridesFromEnv,
  createServiceLogger,
  ensure0x,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { RebalancerConfig } from './config/RebalancerConfig.js';
import { RebalancerService } from './core/RebalancerService.js';

async function main(): Promise<void> {
  const VERSION = process.env.SERVICE_VERSION || 'dev';
  // Validate required environment variables
  const configFile = process.env.REBALANCER_CONFIG_FILE;
  if (!configFile) {
    rootLogger.error('REBALANCER_CONFIG_FILE environment variable is required');
    process.exit(1);
  }

  const rebalancerPrivateKey =
    process.env.HYP_REBALANCER_KEY ?? process.env.HYP_KEY;
  if (!rebalancerPrivateKey) {
    rootLogger.error(
      'HYP_REBALANCER_KEY (or HYP_KEY) environment variable is required',
    );
    process.exit(1);
  }

  // Optional: inventory key for inventory-based operations (LiFi bridges, transferRemote)
  const inventoryPrivateKey = process.env.HYP_INVENTORY_KEY;

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

    // Apply RPC URL overrides from environment variables
    applyRpcUrlOverridesFromEnv(chainMetadata);

    // Create MultiProvider with signer
    const multiProvider = new MultiProvider(chainMetadata);
    const rebalancerSigner = new LocalAccountViemSigner(
      ensure0x(rebalancerPrivateKey) as `0x${string}`,
    );
    multiProvider.setSharedSigner(rebalancerSigner);
    logger.info(
      { rebalancerAddress: rebalancerSigner.address },
      '✅ Initialized MultiProvider with rebalancer signer',
    );

    // Create inventory MultiProvider if inventory key is provided
    let inventoryMultiProvider: MultiProvider | undefined;
    if (inventoryPrivateKey) {
      inventoryMultiProvider = new MultiProvider(chainMetadata, {
        providers: multiProvider.providers,
      });
      const inventorySigner = new LocalAccountViemSigner(
        ensure0x(inventoryPrivateKey) as `0x${string}`,
      );
      inventoryMultiProvider.setSharedSigner(inventorySigner);

      // Validate against config.inventorySigner if present
      const inventoryAddress = inventorySigner.address;
      if (
        rebalancerConfig.inventorySigner &&
        rebalancerConfig.inventorySigner.toLowerCase() !==
          inventoryAddress.toLowerCase()
      ) {
        throw new Error(
          `inventorySigner mismatch: config has ${rebalancerConfig.inventorySigner} but HYP_INVENTORY_KEY derives to ${inventoryAddress}`,
        );
      }
      logger.info(
        { inventoryAddress },
        '✅ Initialized inventory MultiProvider',
      );
    }

    // Fail fast if config references inventorySigner but no HYP_INVENTORY_KEY is provided
    // Without the matching key, inventory operations would silently use the wrong signer
    if (rebalancerConfig.inventorySigner && !inventoryPrivateKey) {
      logger.error(
        { inventorySigner: rebalancerConfig.inventorySigner },
        'Config specifies inventorySigner but HYP_INVENTORY_KEY is not set. Provide the key or remove inventorySigner from config.',
      );
      process.exit(1);
    }

    // MultiProtocolProvider will be derived from multiProvider in factory
    const multiProtocolProvider = undefined;

    // Create the rebalancer service
    const service = new RebalancerService(
      multiProvider,
      inventoryMultiProvider,
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
    const err = error as Error;
    logger.error(
      { error: err.message, stack: err.stack },
      'Failed to start rebalancer service',
    );
    process.exit(1);
  }
}

// Run the service
main().catch((error) => {
  const err = error as Error;
  rootLogger.error({ error: err.message, stack: err.stack }, 'Fatal error');
  process.exit(1);
});
