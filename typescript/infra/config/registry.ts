import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  ChainAddresses,
  IRegistry,
  MergedRegistry,
  PartialRegistry,
  warpConfigToWarpAddresses,
} from '@hyperlane-xyz/registry';
import {
  FileSystemRegistry,
  getRegistry as getMergedRegistry,
} from '@hyperlane-xyz/registry/fs';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  WarpCoreConfig,
  getDomainId as resolveDomainId,
  getReorgPeriod as resolveReorgPeriod,
} from '@hyperlane-xyz/sdk';
import { assert, objFilter, rootLogger } from '@hyperlane-xyz/utils';

import type { DeployEnvironment } from '../src/config/environment.js';

import { supportedChainNames as mainnet3Chains } from './environments/mainnet3/supportedChainNames.js';
import {
  testChainMetadata,
  testChainNames as testChains,
} from './environments/test/chains.js';
import { supportedChainNames as testnet4Chains } from './environments/testnet4/supportedChainNames.js';

export const DEFAULT_REGISTRY_URI = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../',
  'hyperlane-registry',
);

// A global Registry singleton
// All uses of chain metadata or chain address artifacts should go through this registry.
let registry: FileSystemRegistry;

export function setRegistry(reg: FileSystemRegistry) {
  registry = reg;
}

/**
 * Gets a FileSystemRegistry whose contents are found at the environment
 * variable `REGISTRY_URI`, or `DEFAULT_REGISTRY_URI` if no env var is specified.
 * This registry will not have any environment-specific overrides applied,
 * and is useful for synchronous registry operations that do not require
 * any overrides.
 * @returns A FileSystemRegistry.
 */
export function getRegistry(): FileSystemRegistry {
  if (!registry) {
    const registryUri = process.env.REGISTRY_URI || DEFAULT_REGISTRY_URI;
    rootLogger.debug({ registryUri }, 'Using registry URI');
    registry = new FileSystemRegistry({
      uri: registryUri,
      logger: rootLogger.child({ module: 'infra-registry' }),
    });
  }
  return registry;
}

function getRegistryFromUris(registryUris?: string[]): IRegistry {
  if (registryUris && registryUris.length > 0) {
    return getMergedRegistry({ registryUris, enableProxy: true });
  } else {
    return getRegistry();
  }
}

export function getChains(): ChainName[] {
  return getRegistry().getChains();
}

export function getChain(chainName: ChainName): ChainMetadata {
  if (testChains.includes(chainName)) {
    return testChainMetadata[chainName];
  }
  const chain = getRegistry().getChainMetadata(chainName);
  assert(chain, `Chain not found: ${chainName}`);
  return chain;
}

export function getDomainId(chainName: ChainName): number {
  const chain = getChain(chainName);
  return resolveDomainId(chain);
}

export function getReorgPeriod(chainName: ChainName): string | number {
  const chain = getChain(chainName);
  return resolveReorgPeriod(chain);
}

export function getChainMetadata(): ChainMap<ChainMetadata> {
  return getRegistry().getMetadata();
}

export function getChainAddresses(): ChainMap<ChainAddresses> {
  return getRegistry().getAddresses();
}

export function getWarpCoreConfig(warpRouteId: string): WarpCoreConfig {
  const registry = getRegistry();
  const warpRouteConfig = registry.getWarpRoute(warpRouteId);

  if (!warpRouteConfig) {
    throw new Error(
      `Warp route config for ${warpRouteId} not found in registry`,
    );
  }
  return warpRouteConfig;
}

export function getWarpAddresses(
  warpRouteId: string,
): ChainMap<ChainAddresses> {
  const warpCoreConfig = getWarpCoreConfig(warpRouteId);
  return warpConfigToWarpAddresses(warpCoreConfig);
}

export async function getWarpAddressesFrom(
  warpRouteId: string,
  registryUris?: string[],
): Promise<ChainMap<ChainAddresses>> {
  const registry = getRegistryFromUris(registryUris);
  const warpRouteConfig = await registry.getWarpRoute(warpRouteId);
  if (!warpRouteConfig) {
    throw new Error(
      `Warp route config for ${warpRouteId} not found in ${registry.uri}`,
    );
  }
  return warpConfigToWarpAddresses(warpRouteConfig);
}

export function getEnvChains(env: DeployEnvironment): ChainName[] {
  if (env === 'mainnet3') return mainnet3Chains;
  if (env === 'testnet4') return testnet4Chains;
  if (env === 'test') return testChains;
  throw Error(`Unsupported deploy environment: ${env}`);
}

export function getMainnets(): ChainName[] {
  return getEnvChains('mainnet3');
}

export function getTestnets(): ChainName[] {
  return getEnvChains('testnet4');
}

export function getEnvAddresses(
  env: DeployEnvironment,
): ChainMap<ChainAddresses> {
  const envChains = getEnvChains(env);
  return objFilter(getChainAddresses(), (chain, _): _ is ChainAddresses =>
    envChains.includes(chain),
  );
}

export function getMainnetAddresses(): ChainMap<ChainAddresses> {
  return getEnvAddresses('mainnet3');
}

export function getTestnetAddresses(): ChainMap<ChainAddresses> {
  return getEnvAddresses('testnet4');
}

/**
 * Gets a registry, applying the provided overrides. The base registry
 * that the overrides are applied to is the registry returned by `getRegistry`.
 * @param chainMetadataOverrides Chain metadata overrides.
 * @param chainAddressesOverrides Chain address overrides.
 * @returns A MergedRegistry merging the registry from `getRegistry` and the overrides.
 */
export function getRegistryWithOverrides(
  chainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {},
  chainAddressesOverrides: ChainMap<Partial<ChainAddresses>> = {},
): MergedRegistry {
  const baseRegistry = getRegistry();

  const overrideRegistry = new PartialRegistry({
    chainMetadata: chainMetadataOverrides,
    chainAddresses: chainAddressesOverrides,
  });

  return new MergedRegistry({
    registries: [baseRegistry, overrideRegistry],
  });
}
