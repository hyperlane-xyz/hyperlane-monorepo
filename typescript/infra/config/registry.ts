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
        domainRoutingIsm: '0xb0279Db6a2F1E01fbC8483FCCef0Be2bC6299cC3',
        merkleTreeHook: '0x4826533B4897376654Bb4d4AD88B7faFD0C98528',
        proxyAdmin: '0xc5a5C42992dECbae36851359345FE25997F5C42d',
        storageGasOracle: '0x0E801D84Fa97b50751Dbf25036d067dCf18858bF',
        interchainGasPaymaster: '0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00',
        aggregationHook: '0x7F54A0734c5B443E5B04cc26B54bb8ecE0455785',
        fallbackRoutingHook: '0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf',
        protocolFee: '0x1291Be112d480055DaFd8a610b7d1e203891C274',
        testRecipient: '0xCD8a1C3ba11CF5ECfa6267617243239504a98d90',
        mailbox: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E',
        validatorAnnounce: '0xb7278A61aa25c888815aFC32Ad3cC52fF24fE575',
        interchainSecurityModule: '0xb0279Db6a2F1E01fbC8483FCCef0Be2bC6299cC3',
      },
      test2: {
        domainRoutingIsm: '0x3Ca8f9C04c7e3E1624Ac2008F92f6F366A869444',
        merkleTreeHook: '0x04C89607413713Ec9775E14b954286519d836FEf',
        proxyAdmin: '0x2bdCC0de6bE1f7D2ee689a0342D76F52E8EFABa3',
        storageGasOracle: '0x21dF544947ba3E8b3c32561399E88B52Dc8b2823',
        interchainGasPaymaster: '0xDC11f7E700A4c898AE5CAddB1082cFfa76512aDD',
        aggregationHook: '0x5f07F66a6c12BAE727A0e0C84c2f83Ef3c83b44c',
        fallbackRoutingHook: '0x4C4a2f8c81640e47606d3fd77B353E87Ba015584',
        protocolFee: '0x0355B7B8cb128fA5692729Ab3AAa199C1753f726',
        testRecipient: '0x172076E0166D1F9Cc711C77Adf8488051744980C',
        mailbox: '0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650',
        validatorAnnounce: '0xf4B146FbA71F41E0592668ffbF264F1D186b2Ca8',
        interchainSecurityModule: '0x3Ca8f9C04c7e3E1624Ac2008F92f6F366A869444',
      },
      test3: {
        domainRoutingIsm: '0xa12fFA0B9f159BB4C54bce579611927Addc51610',
        merkleTreeHook: '0xA4899D35897033b927acFCf422bc745916139776',
        proxyAdmin: '0xBEc49fA140aCaA83533fB00A2BB19bDdd0290f25',
        storageGasOracle: '0xAA292E8611aDF267e563f334Ee42320aC96D0463',
        interchainGasPaymaster: '0xe8D2A1E88c91DCd5433208d4152Cc4F399a7e91d',
        aggregationHook: '0xd5BA21a5bDE25af311a900191c52ce9Fc8Ab9b8d',
        fallbackRoutingHook: '0xf953b3A269d80e3eB0F2947630Da976B896A8C5b',
        protocolFee: '0xCace1b78160AE76398F486c8a18044da0d66d86D',
        testRecipient: '0xc0F115A19107322cFBf1cDBC7ea011C19EbDB4F8',
        mailbox: '0x2B0d36FACD61B71CC05ab8F3D2355ec3631C0dd5',
        validatorAnnounce: '0xF8e31cb472bc70500f08Cd84917E5A1912Ec8397',
        interchainSecurityModule: '0xa12fFA0B9f159BB4C54bce579611927Addc51610',
      },
      test4: {
        domainRoutingIsm: '0x532B02BD614Fd18aEE45603d02866cFb77575CB3',
        merkleTreeHook: '0xE3011A37A904aB90C8881a99BD1F6E21401f1522',
        proxyAdmin: '0x34B40BA116d5Dec75548a9e9A8f15411461E8c70',
        storageGasOracle: '0x457cCf29090fe5A24c19c1bc95F492168C0EaFdb',
        interchainGasPaymaster: '0x5fc748f1FEb28d7b76fa1c6B07D8ba2d5535177c',
        aggregationHook: '0xfD4Ab5938aAcE9B094cc3B298d18be83E170B2fc',
        fallbackRoutingHook: '0x1f10F3Ba7ACB61b2F50B9d6DdCf91a6f787C0E82',
        protocolFee: '0x8A93d247134d91e0de6f96547cB0204e5BE8e5D8',
        testRecipient: '0xd6e1afe5cA8D00A2EFC01B89997abE2De47fdfAf',
        mailbox: '0x07882Ae1ecB7429a84f1D53048d35c4bB2056877',
        validatorAnnounce: '0xF32D39ff9f6Aa7a7A64d7a4F00a54826Ef791a55',
        interchainSecurityModule: '0x532B02BD614Fd18aEE45603d02866cFb77575CB3',
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
