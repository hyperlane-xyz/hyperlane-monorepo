import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import { LocalRegistry } from '@hyperlane-xyz/registry/local';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  getDomainId as resolveDomainId,
  getReorgPeriod as resolveReorgPeriod,
} from '@hyperlane-xyz/sdk';
import { objFilter, rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../src/config/environment.js';

const DEFAULT_REGISTRY_URI = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../',
  'hyperlane-registry',
);

// A global Registry singleton
// All uses of chain metadata or chain address artifacts should go through this registry.
let registry: LocalRegistry;

export function setRegistry(reg: LocalRegistry) {
  registry = reg;
}

export function getRegistry(): LocalRegistry {
  if (!registry) {
    const registryUri = process.env.REGISTRY_URI || DEFAULT_REGISTRY_URI;
    rootLogger.info('Using registry URI:', registryUri);
    registry = new LocalRegistry({
      uri: registryUri,
      logger: rootLogger.child({ module: 'infra-registry' }),
    });
  }
  return registry;
}

export function getChains(): ChainName[] {
  return getRegistry().getChains();
}

export function getChain(chainName: ChainName): ChainMetadata {
  return getRegistry().getChainMetadata(chainName);
}

export function getDomainId(chainName: ChainName): number {
  return resolveDomainId(getChain(chainName));
}

export function getReorgPeriod(chainName: ChainName): number {
  return resolveReorgPeriod(getChain(chainName));
}

export function getChainMetadata(): ChainMap<ChainMetadata> {
  return getRegistry().getMetadata();
}

export function getChainAddresses(): ChainMap<ChainAddresses> {
  return getRegistry().getAddresses();
}

export function getEnvChains(env: DeployEnvironment): ChainName[] {
  return Object.values(getChainMetadata())
    .filter((chain) => {
      if (env === 'test') return /^test[0-9]$/.test(chain.name);
      if (env === 'testnet4') return chain.isTestnet;
      if (env === 'mainnet3') return !chain.isTestnet;
      throw new Error(`Unknown environment ${env}`);
    })
    .map((chain) => chain.name);
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
  return objFilter(
    getChainAddresses(),
    (chain, addresses): addresses is ChainAddresses =>
      getEnvChains(env).includes(chain),
  );
}

export function getMainnetAddresses(): ChainMap<ChainAddresses> {
  return getEnvAddresses('mainnet3');
}

export function getTestnetAddresses(): ChainMap<ChainAddresses> {
  return getEnvAddresses('testnet4');
}
