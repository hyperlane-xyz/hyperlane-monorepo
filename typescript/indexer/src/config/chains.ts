import { http } from 'viem';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { getLogger } from '../utils/logger.js';

export type DeployEnv = 'mainnet3' | 'testnet4';

export interface IndexerChainConfig {
  name: string;
  chainId: number;
  domainId: number;
  rpcUrl: string;
  startBlock?: number;
  isTestnet: boolean;
}

/**
 * Load chain configs from registry, filtering to EVM chains only.
 *
 * Chain filtering (in order of precedence):
 *   1. INDEXED_CHAINS env var (comma-separated list of chain names)
 *   2. All EVM chains from registry matching environment (mainnet3/testnet4)
 *
 * RPC URLs can be overridden via environment variables:
 *   - HYP_RPC_<CHAIN_NAME_UPPERCASE>=url
 *   - Or via CHAIN_RPC_URLS JSON: {"chainName": "url"}
 */
export async function loadChainConfigs(
  env: DeployEnv,
): Promise<IndexerChainConfig[]> {
  // Dynamic import to avoid issues with ESM/CJS
  const { getRegistry } = await import('@hyperlane-xyz/registry/fs');

  // Use GitHub registry by default, can be overridden with REGISTRY_URI
  // For GitHub registries, can include /tree/{commit} to pin version
  const registryUri = process.env.REGISTRY_URI || DEFAULT_GITHUB_REGISTRY;
  getLogger().info({ registryUri }, 'Loading chain configs from registry');

  const registry = getRegistry({
    registryUris: [registryUri],
    enableProxy: true,
    logger: rootLogger,
  });
  const allMetadata = await registry.getMetadata();

  // Get chains to index: explicit list or all chains from registry
  const chainsToIndex = parseIndexedChains();
  const chainNames =
    chainsToIndex.length > 0 ? chainsToIndex : Object.keys(allMetadata);

  if (chainsToIndex.length > 0) {
    getLogger().info({ chains: chainsToIndex }, 'Indexing specified chains');
  } else {
    getLogger().info({ env }, 'Indexing all EVM chains from registry');
  }

  // Parse RPC URL overrides from environment
  const rpcOverrides = parseRpcOverrides();
  const isTestnetEnv = env === 'testnet4';

  const configs: IndexerChainConfig[] = [];

  for (const chainName of chainNames) {
    const metadata = allMetadata[chainName];
    if (!metadata) {
      getLogger().warn({ chain: chainName }, 'Chain not found in registry');
      continue;
    }

    // Only index EVM chains
    if (metadata.protocol !== ProtocolType.Ethereum) {
      continue;
    }

    // Filter by environment (testnet vs mainnet) when using all chains
    if (chainsToIndex.length === 0) {
      const isTestnet = metadata.isTestnet ?? false;
      if (isTestnet !== isTestnetEnv) {
        continue;
      }
    }

    const chainId = metadata.chainId as number;
    const domainId = metadata.domainId ?? chainId;

    // Get RPC URL: env override > registry
    const rpcUrl = getRpcUrl(chainName, metadata, rpcOverrides);
    if (!rpcUrl) {
      getLogger().warn({ chain: chainName }, 'No RPC URL, skipping chain');
      continue;
    }

    // Use registry startBlock, or fallback to recent block for testnets
    // to avoid syncing from genesis
    const startBlock = metadata.index?.from ?? getDefaultStartBlock(chainName);

    configs.push({
      name: chainName,
      chainId,
      domainId,
      rpcUrl,
      startBlock,
      isTestnet: metadata.isTestnet ?? false,
    });
  }

  return configs;
}

/**
 * Parse INDEXED_CHAINS environment variable.
 * Format: comma-separated list of chain names (e.g., "ethereum,arbitrum,optimism")
 */
function parseIndexedChains(): string[] {
  const indexedChains = process.env.INDEXED_CHAINS;
  if (!indexedChains) {
    return [];
  }

  return indexedChains
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
}

function parseRpcOverrides(): Record<string, string> {
  const overrides: Record<string, string> = {};

  // Parse CHAIN_RPC_URLS JSON if present
  const jsonOverrides = process.env.CHAIN_RPC_URLS;
  if (jsonOverrides) {
    try {
      Object.assign(overrides, JSON.parse(jsonOverrides));
    } catch (err) {
      getLogger().warn({ err }, 'Failed to parse CHAIN_RPC_URLS JSON');
    }
  }

  // Parse HYP_RPC_<CHAIN> environment variables
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('HYP_RPC_') && value) {
      const chainName = key.slice(8).toLowerCase();
      overrides[chainName] = value;
    }
  }

  return overrides;
}

/**
 * Default start blocks for chains without index.from in registry.
 * These are approximate deployment blocks for Hyperlane contracts.
 */
const DEFAULT_START_BLOCKS: Record<string, number> = {
  // Testnets - use recent blocks for faster initial sync
  sepolia: 10203013, // More recent block
  arbitrumsepolia: 1000000,
  basesepolia: 1000000,
  optimismsepolia: 1000000,
  // Add more as needed
};

function getDefaultStartBlock(chainName: string): number | undefined {
  return DEFAULT_START_BLOCKS[chainName.toLowerCase()];
}

function getRpcUrl(
  chainName: string,
  metadata: ChainMetadata,
  overrides: Record<string, string>,
): string | undefined {
  // Check overrides first (case-insensitive)
  const overrideKey = Object.keys(overrides).find(
    (k) => k.toLowerCase() === chainName.toLowerCase(),
  );
  if (overrideKey) {
    return overrides[overrideKey];
  }

  // Fall back to first registry RPC URL
  if (metadata.rpcUrls && metadata.rpcUrls.length > 0) {
    return metadata.rpcUrls[0].http;
  }

  return undefined;
}

/**
 * Build Ponder chains configuration from chain configs.
 * Note: Ponder 0.11+ uses 'chains' instead of 'networks', 'id' instead of 'chainId',
 * and 'rpc' instead of 'transport'.
 */
export function buildPonderChains(chains: IndexerChainConfig[]) {
  return Object.fromEntries(
    chains.map((chain) => [
      chain.name,
      {
        id: chain.chainId,
        rpc: http(chain.rpcUrl),
      },
    ]),
  );
}
