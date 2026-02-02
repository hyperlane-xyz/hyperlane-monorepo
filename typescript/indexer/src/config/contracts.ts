import type { IndexerChainConfig } from './chains.js';

export interface ContractAddresses {
  mailbox: `0x${string}`;
  interchainGasPaymaster?: `0x${string}`;
  merkleTreeHook?: `0x${string}`;
}

/**
 * Load contract addresses for chains from registry.
 */
export async function loadContractAddresses(
  chains: IndexerChainConfig[],
): Promise<Record<string, ContractAddresses>> {
  const { FileSystemRegistry } = await import('@hyperlane-xyz/registry/fs');

  const registryUri = process.env.REGISTRY_URI;
  if (!registryUri) {
    throw new Error('REGISTRY_URI environment variable required');
  }

  const registry = new FileSystemRegistry({ uri: registryUri });
  const allAddresses = registry.getAddresses();

  const result: Record<string, ContractAddresses> = {};

  for (const chain of chains) {
    const addresses = allAddresses[chain.name];
    if (!addresses?.mailbox) {
      console.warn(`No mailbox address for ${chain.name}, skipping`);
      continue;
    }

    result[chain.name] = {
      mailbox: addresses.mailbox as `0x${string}`,
      interchainGasPaymaster: addresses.interchainGasPaymaster as
        | `0x${string}`
        | undefined,
      merkleTreeHook: addresses.merkleTreeHook as `0x${string}` | undefined,
    };
  }

  return result;
}

/**
 * Build Ponder contract configuration for Mailbox contracts.
 */
export function buildMailboxContractConfig(
  chains: IndexerChainConfig[],
  addresses: Record<string, ContractAddresses>,
  abi: readonly unknown[],
) {
  const network: Record<
    string,
    { address: `0x${string}`; startBlock?: number }
  > = {};

  for (const chain of chains) {
    const addr = addresses[chain.name];
    if (!addr?.mailbox) continue;

    network[chain.name] = {
      address: addr.mailbox,
      startBlock: chain.startBlock,
    };
  }

  return {
    abi,
    network,
  };
}

/**
 * Build Ponder contract configuration for IGP contracts.
 */
export function buildIgpContractConfig(
  chains: IndexerChainConfig[],
  addresses: Record<string, ContractAddresses>,
  abi: readonly unknown[],
) {
  const network: Record<
    string,
    { address: `0x${string}`; startBlock?: number }
  > = {};

  for (const chain of chains) {
    const addr = addresses[chain.name];
    if (!addr?.interchainGasPaymaster) continue;

    network[chain.name] = {
      address: addr.interchainGasPaymaster,
      startBlock: chain.startBlock,
    };
  }

  return {
    abi,
    network,
  };
}

/**
 * Build Ponder contract configuration for MerkleTreeHook contracts.
 */
export function buildMerkleTreeHookContractConfig(
  chains: IndexerChainConfig[],
  addresses: Record<string, ContractAddresses>,
  abi: readonly unknown[],
) {
  const network: Record<
    string,
    { address: `0x${string}`; startBlock?: number }
  > = {};

  for (const chain of chains) {
    const addr = addresses[chain.name];
    if (!addr?.merkleTreeHook) continue;

    network[chain.name] = {
      address: addr.merkleTreeHook,
      startBlock: chain.startBlock,
    };
  }

  return {
    abi,
    network,
  };
}
