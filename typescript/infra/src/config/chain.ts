import { providers } from 'ethers';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  HyperlaneSmartProvider,
  ProviderRetryOptions,
  safeApiKeyRequired,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  inCIMode,
  inKubernetes,
  objFilter,
  objMerge,
} from '@hyperlane-xyz/utils';

import { getChain, getRegistryWithOverrides } from '../../config/registry.js';
import { getSecretRpcEndpoints } from '../agents/index.js';
import { getSafeApiKey } from '../utils/safe.js';

import { DeployEnvironment } from './environment.js';

// V2 ICAs are not supported on these chains, due to the block gas limit being
// lower than the amount required to deploy the new InterchainAccountRouter
// implementation.
export const legacyIcaChainRouters: Record<
  ChainName,
  {
    interchainAccountIsm: Address;
    interchainAccountRouter: Address;
  }
> = {
  viction: {
    interchainAccountIsm: '0x551BbEc45FD665a8C95ca8731CbC32b7653Bc59B',
    interchainAccountRouter: '0xc11f8Cf2343d3788405582F65B8af6A4F7a6FfC8',
  },
  ontology: {
    interchainAccountIsm: '0x8BdD5bf519714515083801448A99F84882A8F61E',
    interchainAccountRouter: '0x718f11e349374481Be8c8B7589eC4B4316ddDCc2',
  },
};
export const legacyIcaChains = Object.keys(legacyIcaChainRouters);
export const legacyEthIcaRouter = '0x5E532F7B610618eE73C2B462978e94CB1F7995Ce';

// A list of chains to skip during deploy, check-deploy and ICA operations.
// Used by scripts like check-owner-ica.ts to exclude chains that are temporarily
// unsupported (e.g. zksync, zeronetwork) or have known issues
export const chainsToSkip: ChainName[] = [
  // svmbnb support is deprecated
  'svmbnb',
  // shutdown
  'inevm',

  // not AW owned
  'forma',

  // TODO: remove once zksync PR is merged into main
  // mainnets
  'zksync',
  'zeronetwork',
  'abstract',
  'sophon',

  // testnets
  'abstracttestnet',

  // legacy ICAs
  'viction',
  'ontology',

  // legacy icas
  'carrchaintestnet',
  'rometestnet',
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

  // Only fetch Safe API key when running locally (not in k8s)
  // Safe API is only needed for infra + http registry usage
  const safeApiKey = !inKubernetes() ? await getSafeApiKey() : undefined;
  if (safeApiKey) {
    for (const chain of chains) {
      const chainMetadata = getChain(chain);
      const txServiceUrl = chainMetadata.gnosisSafeTransactionServiceUrl;
      if (txServiceUrl && safeApiKeyRequired(txServiceUrl)) {
        chainMetadataOverrides[chain].gnosisSafeApiKey = safeApiKey;
      }
    }
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
