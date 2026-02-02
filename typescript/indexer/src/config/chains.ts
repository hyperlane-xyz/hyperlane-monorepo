import { http } from 'viem';

import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

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
 *   2. All EVM chains from environment (mainnet3/testnet4)
 *
 * RPC URLs can be overridden via environment variables:
 *   - HYP_RPC_<CHAIN_NAME_UPPERCASE>=url
 *   - Or via CHAIN_RPC_URLS JSON: {"chainName": "url"}
 */
export async function loadChainConfigs(
  env: DeployEnv,
): Promise<IndexerChainConfig[]> {
  // Dynamic import to avoid issues with ESM/CJS
  const { FileSystemRegistry } = await import('@hyperlane-xyz/registry/fs');

  const registryUri = process.env.REGISTRY_URI;
  if (!registryUri) {
    throw new Error('REGISTRY_URI environment variable required');
  }

  const registry = new FileSystemRegistry({ uri: registryUri });
  const allMetadata = registry.getMetadata();

  // Get chains to index: explicit list or all supported chains
  const chainsToIndex = parseIndexedChains();
  const supportedChains =
    chainsToIndex.length > 0
      ? chainsToIndex
      : await getSupportedChainNames(env);

  if (chainsToIndex.length > 0) {
    console.log(`Indexing specified chains: ${chainsToIndex.join(', ')}`);
  } else {
    console.log(`Indexing all ${env} EVM chains`);
  }

  // Parse RPC URL overrides from environment
  const rpcOverrides = parseRpcOverrides();

  const configs: IndexerChainConfig[] = [];

  for (const chainName of supportedChains) {
    const metadata = allMetadata[chainName];
    if (!metadata) {
      console.warn(`Chain ${chainName} not found in registry, skipping`);
      continue;
    }

    // Only index EVM chains
    if (metadata.protocol !== ProtocolType.Ethereum) {
      continue;
    }

    const chainId = metadata.chainId as number;
    const domainId = metadata.domainId ?? chainId;

    // Get RPC URL: env override > registry
    const rpcUrl = getRpcUrl(chainName, metadata, rpcOverrides);
    if (!rpcUrl) {
      console.warn(`No RPC URL for ${chainName}, skipping`);
      continue;
    }

    configs.push({
      name: chainName,
      chainId,
      domainId,
      rpcUrl,
      startBlock: metadata.index?.from,
      isTestnet: metadata.isTestnet ?? false,
    });
  }

  return configs;
}

async function getSupportedChainNames(env: DeployEnv): Promise<string[]> {
  // Import supported chain names based on environment
  // These are the chains that Hyperlane infra supports
  if (env === 'mainnet3') {
    const { supportedChainNames } = await import(
      '../../config/mainnet3Chains.js'
    );
    return supportedChainNames;
  } else if (env === 'testnet4') {
    const { supportedChainNames } = await import(
      '../../config/testnet4Chains.js'
    );
    return supportedChainNames;
  }
  throw new Error(`Unknown environment: ${env}`);
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
    } catch {
      console.warn('Failed to parse CHAIN_RPC_URLS JSON');
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
 * Build Ponder network configuration from chain configs.
 */
export function buildPonderNetworks(chains: IndexerChainConfig[]) {
  return Object.fromEntries(
    chains.map((chain) => [
      chain.name,
      {
        chainId: chain.chainId,
        transport: http(chain.rpcUrl),
      },
    ]),
  );
}
