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
 * - HYP_INVENTORY_KEY_<PROTOCOL>: Private key for inventory operations per protocol (e.g., HYP_INVENTORY_KEY_ETHEREUM, HYP_INVENTORY_KEY_SEALEVEL)
 * - COINGECKO_API_KEY: API key for CoinGecko price fetching (optional, for metrics)
 * - HYP_INVENTORY_KEY: Backward-compatible fallback for Ethereum inventory signer (optional, use HYP_INVENTORY_KEY_ETHEREUM preferentially)
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
import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import {
  applyRpcUrlOverridesFromEnv,
  createServiceLogger,
  ProtocolType,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { RebalancerConfig } from './config/RebalancerConfig.js';
import { RebalancerService } from './core/RebalancerService.js';
import { parseSolanaPrivateKey } from './utils/solanaKeyParser.js';
import type { InventorySignerConfig } from './core/InventoryRebalancer.js';

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

  // Build per-protocol private key map from env vars.
  // Naming: HYP_INVENTORY_KEY_<UPPERCASE_PROTOCOL> (e.g., HYP_INVENTORY_KEY_ETHEREUM).
  // HYP_INVENTORY_KEY (no suffix) is kept as backward-compatible fallback for Ethereum only.
  const inventoryPrivateKeys: Partial<Record<ProtocolType, string>> = {};
  for (const protocol of Object.values(ProtocolType)) {
    const envKey = `HYP_INVENTORY_KEY_${protocol.toUpperCase()}`;
    const val = process.env[envKey];
    if (val) {
      inventoryPrivateKeys[protocol] = val;
    }
  }
  // Backward compat: HYP_INVENTORY_KEY (no suffix) as Ethereum fallback
  if (
    !inventoryPrivateKeys[ProtocolType.Ethereum] &&
    process.env.HYP_INVENTORY_KEY
  ) {
    inventoryPrivateKeys[ProtocolType.Ethereum] = process.env.HYP_INVENTORY_KEY;
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

    // Apply RPC URL overrides from environment variables
    applyRpcUrlOverridesFromEnv(chainMetadata);

    // Create MultiProvider with signer
    const multiProvider = new MultiProvider(chainMetadata);
    const rebalancerSigner = new Wallet(rebalancerPrivateKey);
    multiProvider.setSharedSigner(rebalancerSigner);
    logger.info(
      { rebalancerAddress: rebalancerSigner.address },
      '✅ Initialized MultiProvider with rebalancer signer',
    );

    // Build consolidated inventory signers with keys embedded
    const inventorySigners: Partial<
      Record<ProtocolType, InventorySignerConfig>
    > = {};

    for (const [protocol, privateKey] of Object.entries(inventoryPrivateKeys)) {
      if (!privateKey) continue;

      let derivedAddress: string;

      if (protocol === ProtocolType.Ethereum) {
        derivedAddress = new Wallet(privateKey).address;
      } else if (protocol === ProtocolType.Sealevel) {
        const keyBytes = parseSolanaPrivateKey(privateKey);
        const keypair = Keypair.fromSecretKey(keyBytes);
        derivedAddress = keypair.publicKey.toBase58();
      } else {
        logger.warn(
          { protocol },
          `Unsupported protocol for inventory signer derivation, skipping`,
        );
        continue;
      }

      // Validate against config if present
      const configuredAddress =
        rebalancerConfig.inventorySigners?.[protocol as ProtocolType]?.address;
      if (configuredAddress) {
        const mismatch =
          protocol === ProtocolType.Ethereum
            ? configuredAddress.toLowerCase() !== derivedAddress.toLowerCase()
            : configuredAddress !== derivedAddress;
        if (mismatch) {
          throw new Error(
            `inventorySigners.${protocol} mismatch: config has ${configuredAddress} but HYP_INVENTORY_KEY_${protocol.toUpperCase()} derives to ${derivedAddress}`,
          );
        }
      }

      inventorySigners[protocol as ProtocolType] = {
        address: derivedAddress,
        key: privateKey,
      };
      logger.info(
        { protocol, address: derivedAddress },
        `✅ ${protocol} inventory signer configured`,
      );
    }

    // Fail fast if config references protocol-specific inventory signer but key is missing
    if (!monitorOnly) {
      for (const protocol of Object.values(ProtocolType)) {
        if (
          rebalancerConfig.inventorySigners?.[protocol] &&
          !inventoryPrivateKeys[protocol]
        ) {
          const envKey = `HYP_INVENTORY_KEY_${protocol.toUpperCase()}`;
          const hint =
            protocol === ProtocolType.Ethereum
              ? `${envKey} (or fallback HYP_INVENTORY_KEY)`
              : envKey;
          logger.error(
            {
              inventorySigner:
                rebalancerConfig.inventorySigners[protocol]?.address,
            },
            `Config specifies inventorySigners.${protocol} but ${hint} is not set.`,
          );
          process.exit(1);
        }
      }
    }

    // Merge runtime keys into config — start from YAML config as base, overlay runtime keys per-protocol.
    // This preserves YAML-only signer addresses (e.g., monitor-only configs) while adding runtime keys.
    const mergedInventorySigners: Partial<
      Record<ProtocolType, InventorySignerConfig>
    > = { ...rebalancerConfig.inventorySigners };
    for (const protocol of Object.values(ProtocolType)) {
      const runtimeSigner = inventorySigners[protocol];
      if (runtimeSigner) {
        mergedInventorySigners[protocol] = {
          ...mergedInventorySigners[protocol],
          ...runtimeSigner,
        };
      }
    }

    const mergedRebalancerConfig =
      Object.keys(mergedInventorySigners).length > 0
        ? new RebalancerConfig(
            rebalancerConfig.warpRouteId,
            rebalancerConfig.strategyConfig,
            rebalancerConfig.intentTTL,
            mergedInventorySigners,
            rebalancerConfig.externalBridges,
          )
        : rebalancerConfig;

    // MultiProtocolProvider will be derived from multiProvider in factory
    const multiProtocolProvider = undefined;

    // Create the rebalancer service
    const service = new RebalancerService(
      multiProvider,
      multiProtocolProvider,
      registry,
      mergedRebalancerConfig,
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
