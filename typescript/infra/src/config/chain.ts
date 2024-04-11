import { providers } from 'ethers';

import {
  ChainMetadata,
  ChainMetadataManager,
  ChainName,
  CoreChainName,
  HyperlaneSmartProvider,
  ProviderRetryOptions,
  RpcConsensusType,
  chainMetadata,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objFilter } from '@hyperlane-xyz/utils';

import { getSecretRpcEndpoint } from '../agents/index.js';

import { DeployEnvironment } from './environment.js';

export const defaultRetry: ProviderRetryOptions = {
  maxRetries: 6,
  baseRetryDelayMs: 50,
};

export async function fetchProvider(
  environment: DeployEnvironment,
  chainName: ChainName,
  connectionType: RpcConsensusType = RpcConsensusType.Single,
): Promise<providers.Provider> {
  const cmm = new ChainMetadataManager(chainMetadata);
  const chainData = cmm.tryGetChainMetadata(chainName);
  if (!chainData) {
    throw Error(`Unsupported chain: ${chainName}`);
  }
  const chainId = chainData.chainId;
  const single = connectionType === RpcConsensusType.Single;
  let rpcData = chainData.rpcUrls.map((url) => url.http);
  if (rpcData.length === 0) {
    rpcData = await getSecretRpcEndpoint(environment, chainName, !single);
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

export function getChainMetadatas(chains: Array<CoreChainName>) {
  const allMetadatas = Object.fromEntries(
    chains
      .map((chain) => chainMetadata[chain])
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
