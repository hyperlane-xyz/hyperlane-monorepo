import { providers } from 'ethers';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  HyperlaneSmartProvider,
  ProviderRetryOptions,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  inCIMode,
  objFilter,
  objMerge,
} from '@hyperlane-xyz/utils';

import { getChain, getRegistryWithOverrides } from '../../config/registry.js';
import { getSecretRpcEndpoints } from '../agents/index.js';

import { DeployEnvironment } from './environment.js';

// A list of chains to skip during deploy, check-deploy and ICA operations.
// Used by scripts like check-owner-ica.ts to exclude chains that are temporarily
// unsupported (e.g. zksync, zeronetwork) or have known issues (e.g. lumia).
export const chainsToSkip: ChainName[] = [
  // TODO: complete work when RPC is available again
  'infinityvm',

  // TODO: remove once zksync PR is merged into main
  // mainnets
  'zksync',
  'zeronetwork',
  'zklink',
  'treasure',
  'abstract',
  'sophon',

  // testnets
  'abstracttestnet',
  'treasuretopaz',

  // Oct 16 batch
  'lumia',
];

export const defaultRetry: ProviderRetryOptions = {
  maxRetries: 6,
  baseRetryDelayMs: 50,
};

export async function fetchProvider(
  chainName: ChainName,
): Promise<providers.Provider> {
  const chainMetadata = getChain(chainName);
  if (!chainMetadata) {
    throw Error(`Unsupported chain: ${chainName}`);
  }
  const chainId = chainMetadata.chainId;
  const rpcData = chainMetadata.rpcUrls.map((url) => url.http);
  if (rpcData.length === 0) {
    throw Error(`No RPC URLs found for chain: ${chainName}`);
  }

  return new HyperlaneSmartProvider(
    chainId,
    rpcData.map((url) => ({ http: url })),
    undefined,
    defaultRetry,
  );
}

export function getChainMetadatas(chains: Array<ChainName>) {
  const allMetadatas = Object.fromEntries(
    chains
      .map((chain) => getChain(chain))
      .map((metadata) => [metadata.name, metadata]),
  );

  const ethereumMetadatas = objFilter(
    allMetadatas,
    (_, metadata): metadata is ChainMetadata =>
      metadata.protocol === ProtocolType.Ethereum,
  );
  const nonEthereumMetadatas = objFilter(
    allMetadatas,
    (_, metadata): metadata is ChainMetadata =>
      metadata.protocol !== ProtocolType.Ethereum,
  );

  return { ethereumMetadatas, nonEthereumMetadatas };
}

/**
 * Gets the registry for the given environment, with optional overrides and
 * the ability to get overrides from secrets.
 * @param deployEnv The deploy environment.
 * @param chains The chains to get metadata for.
 * @param defaultChainMetadataOverrides The default chain metadata overrides. If
 * secret overrides are used, the secret overrides will be merged with these and
 * take precedence.
 * @param useSecrets Whether to fetch metadata overrides from secrets.
 * @returns A registry with overrides for the given environment.
 */
export async function getRegistryForEnvironment(
  deployEnv: DeployEnvironment,
  chains: ChainName[],
  defaultChainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {},
  useSecrets: boolean = true,
): Promise<IRegistry> {
  let overrides = defaultChainMetadataOverrides;
  if (useSecrets) {
    overrides = objMerge(
      overrides,
      !inCIMode()
        ? await getSecretMetadataOverrides(deployEnv, chains)
        : await getSecretMetadataOverridesFromGitHubSecrets(deployEnv, chains),
    );
  }
  const registry = getRegistryWithOverrides(overrides);
  return registry;
}

/**
 * Gets chain metadata overrides from GCP secrets.
 * @param deployEnv The deploy environment.
 * @param chains The chains to get metadata overrides for.
 * @returns A partial chain metadata map with the secret overrides.
 */
export async function getSecretMetadataOverrides(
  deployEnv: DeployEnvironment,
  chains: string[],
): Promise<ChainMap<Partial<ChainMetadata>>> {
  const chainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {};

  const secretRpcUrls = await Promise.all(
    chains.map(async (chain) => {
      const rpcUrls = await getSecretRpcEndpoints(deployEnv, chain);
      return {
        chain,
        rpcUrls,
      };
    }),
  );

  for (const { chain, rpcUrls } of secretRpcUrls) {
    if (rpcUrls.length === 0) {
      throw Error(`No secret RPC URLs found for chain: ${chain}`);
    }
    // Need explicit casting here because Zod expects a non-empty array.
    const metadataRpcUrls = rpcUrls.map((rpcUrl: string) => ({
      http: rpcUrl,
    })) as ChainMetadata['rpcUrls'];
    chainMetadataOverrides[chain] = {
      rpcUrls: metadataRpcUrls,
    };
  }

  return chainMetadataOverrides;
}

/**
 * Gets chain metadata overrides from GitHub secrets.
 * This function is intended to be used when running in CI/CD environments,
 * where secrets are injected as environment variables.
 * @param deployEnv The deploy environment.
 * @param chains The chains to get metadata overrides for.
 * @returns A partial chain metadata map with the secret overrides.
 */
export async function getSecretMetadataOverridesFromGitHubSecrets(
  deployEnv: DeployEnvironment,
  chains: string[],
): Promise<ChainMap<Partial<ChainMetadata>>> {
  const chainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {};

  for (const chain of chains) {
    const rpcUrlsEnv = `${deployEnv.toUpperCase()}_${chain.toUpperCase()}_RPC_URLS`;
    const rpcUrls = process.env[rpcUrlsEnv];
    if (rpcUrls) {
      const metadataRpcUrls = rpcUrls
        .split(',')
        .map((rpcUrl) => ({ http: rpcUrl })) as ChainMetadata['rpcUrls'];
      chainMetadataOverrides[chain] = {
        rpcUrls: metadataRpcUrls,
      };
    }
  }

  return chainMetadataOverrides;
}
