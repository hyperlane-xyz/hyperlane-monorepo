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
  if (env === 'test') {
    const rawAddresses = {
      test1: {
        proxyAdmin: '0x84eA74d481Ee0A5332c457a4d796187F6Ba67fEB',
        mailbox: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9',
        domainRoutingIsm: '0x0665FbB86a3acECa91Df68388EC4BBE11556DDce',
        merkleTreeHook: '0x9d4454B023096f34B160D6B654540c56A1F81688',
        storageGasOracle: '0x36C02dA8a0983159322a80FFE9F24b1acfF8B570',
        interchainGasPaymaster: '0x1291Be112d480055DaFd8a610b7d1e203891C274',
        aggregationHook: '0xFB0C730494aBf3Fc590d6cb7672Ac3ffF374dBCC',
        fallbackRoutingHook: '0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00',
        protocolFee: '0x82e01223d51Eb87e16A03E24687EDF0F294da6f1',
        testRecipient: '0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650',
        validatorAnnounce: '0x7969c5eD335650692Bc04293B07F5BF2e7A673C0',
        interchainSecurityModule: '0x0665FbB86a3acECa91Df68388EC4BBE11556DDce',
      },
      test2: {
        proxyAdmin: '0xFD471836031dc5108809D173A067e8486B9047A3',
        mailbox: '0x1429859428C0aBc9C2C47C8Ee9FBaf82cFA0F20f',
        domainRoutingIsm: '0x8Ba41269ed69496c07bea886c300016A0BA8FB5E',
        merkleTreeHook: '0xD8a5a9b31c3C0232E196d518E89Fd8bF83AcAd43',
        storageGasOracle: '0x51A1ceB83B83F1985a81C295d1fF28Afef186E02',
        interchainGasPaymaster: '0x0355B7B8cb128fA5692729Ab3AAa199C1753f726',
        aggregationHook: '0xE3dB5684756530bfB14dEAdfcDdBaf9ef8233fE4',
        fallbackRoutingHook: '0xDC11f7E700A4c898AE5CAddB1082cFfa76512aDD',
        protocolFee: '0x4EE6eCAD1c2Dae9f525404De8555724e3c35d07B',
        testRecipient: '0x2B0d36FACD61B71CC05ab8F3D2355ec3631C0dd5',
        validatorAnnounce: '0xD84379CEae14AA33C123Af12424A37803F885889',
        interchainSecurityModule: '0x8Ba41269ed69496c07bea886c300016A0BA8FB5E',
      },
    };
    // @ts-ignore
    return objFilter(rawAddresses, (chain, _): _ is ChainAddresses =>
      envChains.includes(chain),
    );
  }

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
