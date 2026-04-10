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
 * - HYP_REBALANCER_SUBMITTER_REF: Submitter reference URI for movable collateral rebalancing operations
 * - HYP_REBALANCER_KEY: Private key for movable collateral rebalancing operations (preferred)
 * - HYP_KEY: Fallback private key for HYP_REBALANCER_KEY (optional)
 * - HYP_INVENTORY_KEY_<PROTOCOL>: Private key for inventory operations per protocol (e.g., HYP_INVENTORY_KEY_ETHEREUM, HYP_INVENTORY_KEY_SEALEVEL)
 * - HYP_INVENTORY_SUBMITTER_REF: Submitter reference URI for inventory operations (optional)
 * - COINGECKO_API_KEY: API key for CoinGecko price fetching (optional, for metrics)
 * - HYP_INVENTORY_KEY: Backward-compatible fallback for Ethereum inventory signer (optional, use HYP_INVENTORY_KEY_ETHEREUM preferentially)
 * - CHECK_FREQUENCY: Balance check frequency in ms (default: 60000)
 * - WITH_METRICS: Enable Prometheus metrics (default: "true")
 * - MONITOR_ONLY: Run in monitor-only mode without executing transactions (default: "false")
 * - LOG_LEVEL: Logging level (default: "info") - supported by pino
 * - REGISTRY_URI: Registry URI for chain metadata. Can include /tree/{commit} to pin version (default: GitHub registry)
 * - GH_AUTH_TOKEN: GitHub auth token for private or rate-limited registry access (optional)
 * - RPC_URL_<CHAIN>: Override RPC URL for a specific chain (e.g., RPC_URL_ETHEREUM, RPC_URL_ARBITRUM)
 *
 * Usage:
 *   node dist/service.js
 *   REBALANCER_CONFIG_FILE=/config/rebalancer.yaml HYP_REBALANCER_KEY=0x... HYP_INVENTORY_KEY=0x... node dist/service.js
 */
import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import { pathToFileURL } from 'url';

import {
  DEFAULT_GITHUB_REGISTRY,
  type IRegistry,
} from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  MultiProvider,
  TxSubmitterType,
  parseSubmitterReferencePayload,
  resolveSubmitterMetadata,
} from '@hyperlane-xyz/sdk';
import {
  applyRpcUrlOverridesFromEnv,
  createServiceLogger,
  ProtocolType,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { readYamlOrJson } from '@hyperlane-xyz/utils/fs';

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

  const rebalancerSubmitterRef = process.env.HYP_REBALANCER_SUBMITTER_REF;
  let rebalancerPrivateKey =
    process.env.HYP_REBALANCER_KEY ?? process.env.HYP_KEY;

  // Build per-protocol private key map from env vars.
  // Naming: HYP_INVENTORY_KEY_<UPPERCASE_PROTOCOL> (e.g., HYP_INVENTORY_KEY_ETHEREUM).
  // HYP_INVENTORY_KEY (no suffix) is kept as backward-compatible fallback for Ethereum only.
  const inventorySubmitterRef = process.env.HYP_INVENTORY_SUBMITTER_REF;
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
      authToken: process.env.GH_AUTH_TOKEN,
    });
    logger.info({ registryUri }, '✅ Initialized registry');

    if (rebalancerSubmitterRef) {
      const rebalancerSubmitter = await resolveSubmitterMetadata(
        { type: TxSubmitterType.SUBMITTER_REF, ref: rebalancerSubmitterRef },
        extendRegistryWithSubmitters(registry, process.env.GH_AUTH_TOKEN),
      );
      if (rebalancerSubmitter.type !== TxSubmitterType.JSON_RPC) {
        throw new Error(
          `HYP_REBALANCER_SUBMITTER_REF must resolve to ${TxSubmitterType.JSON_RPC}, got ${rebalancerSubmitter.type}`,
        );
      }
      if (!rebalancerSubmitter.privateKey) {
        throw new Error(
          `HYP_REBALANCER_SUBMITTER_REF must resolve to a private-key-backed ${TxSubmitterType.JSON_RPC} submitter`,
        );
      }
      rebalancerPrivateKey = rebalancerSubmitter.privateKey;
      logger.info(
        {
          rebalancerAddress:
            rebalancerSubmitter.userAddress ??
            new Wallet(rebalancerSubmitter.privateKey).address,
          rebalancerSubmitterRef,
        },
        '✅ Resolved rebalancer submitter reference',
      );
    }
    if (!rebalancerPrivateKey) {
      rootLogger.error(
        'HYP_REBALANCER_SUBMITTER_REF or HYP_REBALANCER_KEY (or HYP_KEY) environment variable is required',
      );
      process.exit(1);
    }

    if (inventorySubmitterRef) {
      const inventorySubmitter = await resolveSubmitterMetadata(
        { type: TxSubmitterType.SUBMITTER_REF, ref: inventorySubmitterRef },
        extendRegistryWithSubmitters(registry, process.env.GH_AUTH_TOKEN),
      );
      if (inventorySubmitter.type !== TxSubmitterType.JSON_RPC) {
        throw new Error(
          `HYP_INVENTORY_SUBMITTER_REF must resolve to ${TxSubmitterType.JSON_RPC}, got ${inventorySubmitter.type}`,
        );
      }
      if (!inventorySubmitter.privateKey) {
        throw new Error(
          `HYP_INVENTORY_SUBMITTER_REF must resolve to a private-key-backed ${TxSubmitterType.JSON_RPC} submitter`,
        );
      }
      inventoryPrivateKeys[ProtocolType.Ethereum] =
        inventorySubmitter.privateKey;
      logger.info(
        {
          inventoryAddress:
            inventorySubmitter.userAddress ??
            new Wallet(inventorySubmitter.privateKey).address,
          inventorySubmitterRef,
        },
        '✅ Resolved inventory submitter reference',
      );
    }

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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const err = error as Error;
    rootLogger.error({ error: err.message, stack: err.stack }, 'Fatal error');
    process.exit(1);
  });
}

const SUBMITTER_DIRECTORY = 'submitters';
const SUPPORTED_EXTENSIONS = ['', '.yaml', '.yml', '.json'];

export type SubmitterRegistry = IRegistry & {
  getSubmitter(ref: string): Promise<unknown>;
};

export function extendRegistryWithSubmitters(
  registry: IRegistry,
  authToken?: string,
): SubmitterRegistry {
  const extendedRegistry = registry as SubmitterRegistry;
  if (!Object.hasOwn(extendedRegistry, 'getSubmitter')) {
    extendedRegistry.getSubmitter = async (ref) =>
      readSubmitterReference(registry, ref, authToken);
  }
  return extendedRegistry;
}

async function readSubmitterReference(
  registry: IRegistry,
  ref: string,
  authToken?: string,
): Promise<unknown> {
  const childRegistries = getRegistryChildren(registry);
  if (childRegistries?.length) {
    for (const childRegistry of childRegistries.slice().reverse()) {
      const payload = await readSubmitterReference(
        childRegistry,
        ref,
        authToken,
      );
      if (payload) return payload;
    }
  }

  for (const itemPath of getCandidateItemPaths(ref, registry)) {
    const source = safeGetUri(registry, itemPath);
    if (!source) continue;

    const payload = await loadPayload(source, authToken);
    if (payload) return payload;
  }

  return null;
}

function getRegistryChildren(registry: IRegistry): IRegistry[] {
  if (!('registries' in registry) || !Array.isArray(registry.registries)) {
    return [];
  }

  return registry.registries.filter(
    (child): child is IRegistry => !!child && typeof child === 'object',
  );
}

function getCandidateItemPaths(ref: string, registry: IRegistry): string[] {
  const strippedRef = stripRegistryRoot(ref, registry);
  if (!strippedRef && isUrl(ref)) return [];

  const normalizedRef = (strippedRef ?? ref).replace(/^\/+/, '');
  if (!normalizedRef.startsWith(`${SUBMITTER_DIRECTORY}/`)) {
    throw new Error(
      `Submitter reference ${ref} must target a top-level ${SUBMITTER_DIRECTORY}/ entry`,
    );
  }

  if (
    SUPPORTED_EXTENSIONS.some(
      (extension) => extension && normalizedRef.endsWith(extension),
    )
  ) {
    return [normalizedRef];
  }

  return SUPPORTED_EXTENSIONS.map((suffix) => `${normalizedRef}${suffix}`);
}

function stripRegistryRoot(ref: string, registry: IRegistry): string | null {
  const roots = [registry.uri, safeGetUri(registry)]
    .filter(
      (value, index, values): value is string =>
        !!value && values.indexOf(value) === index,
    )
    .sort((a, b) => b.length - a.length);

  for (const root of roots) {
    if (ref.startsWith(root)) {
      return ref.slice(root.length).replace(/^\/+/, '');
    }
  }

  return null;
}

function safeGetUri(
  registry: IRegistry,
  itemPath?: string,
): string | undefined {
  try {
    return registry.getUri(itemPath);
  } catch {
    return undefined;
  }
}

async function loadPayload(
  source: string,
  authToken?: string,
): Promise<unknown> {
  if (isFetchableUrl(source)) {
    const response = await fetch(source, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Failed to fetch submitter reference ${source}: ${response.status} ${response.statusText}`,
      );
    }
    return parseSubmitterReferencePayload(await response.text(), source);
  }
  if (isUrl(source)) return null;

  try {
    return readYamlOrJson(source);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function isFetchableUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
