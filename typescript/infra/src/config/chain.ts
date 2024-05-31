import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { providers } from 'ethers';

import { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  HyperlaneSmartProvider,
  ProviderRetryOptions,
  RpcConsensusType,
  RpcUrl,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objFilter, objMerge } from '@hyperlane-xyz/utils';

import { getChain, getRegistryWithOverrides } from '../../config/registry.js';
import { getSecretRpcEndpoints } from '../agents/index.js';

import { DeployEnvironment } from './environment.js';

export const defaultRetry: ProviderRetryOptions = {
  maxRetries: 6,
  baseRetryDelayMs: 50,
};

export async function fetchProvider(
  chainName: ChainName,
  connectionType: RpcConsensusType = RpcConsensusType.Single,
): Promise<providers.Provider> {
  const chainMetadata = getChain(chainName);
  if (!chainMetadata) {
    throw Error(`Unsupported chain: ${chainName}`);
  }
  const chainId = chainMetadata.chainId;
  let rpcData = chainMetadata.rpcUrls.map((url) => url.http);
  if (rpcData.length === 0) {
    throw Error(`No RPC URLs found for chain: ${chainName}`);
  }

  if (connectionType === RpcConsensusType.Single) {
    return HyperlaneSmartProvider.fromRpcUrl(chainId, rpcData[0], defaultRetry);
  } else if (
    connectionType === RpcConsensusType.Quorum ||
    connectionType === RpcConsensusType.Fallback
  ) {
    return new HyperlaneSmartProvider(
      chainId,
      rpcData.map((url) => ({ http: url })),
      undefined,
      // disable retry for quorum
      connectionType === RpcConsensusType.Fallback ? defaultRetry : undefined,
    );
  } else {
    throw Error(`Unsupported connectionType: ${connectionType}`);
  }
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
 * @param defaultChainMetadataOverrides The default chain metadata overrides.
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
      await getSecretMetadataOverrides(deployEnv, chains),
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
  const projectId = 'abacus-labs-dev';

  const client = new SecretManagerServiceClient({
    projectId,
  });

  const chainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {};

  const secretRpcUrls = await Promise.all(
    chains.map(async (chain) => {
      const rpcUrls = await getSecretRpcEndpoints(deployEnv, chain, true);
      return {
        chain,
        rpcUrls,
      };
    }),
  );

  for (const { chain, rpcUrls } of secretRpcUrls) {
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
