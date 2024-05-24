import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { providers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  ChainName,
  HyperlaneSmartProvider,
  ProviderRetryOptions,
  RpcConsensusType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objFilter } from '@hyperlane-xyz/utils';

import { getChain } from '../../config/registry/registry.js';
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
  const chainMetadata = getChain(chainName);
  if (!chainMetadata) {
    throw Error(`Unsupported chain: ${chainName}`);
  }
  const chainId = chainMetadata.chainId;
  const single = connectionType === RpcConsensusType.Single;
  let rpcData = chainMetadata.rpcUrls.map((url) => url.http);
  if (rpcData.length === 0) {
    // todo should probably come back here
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

export async function getSecretMetadataOverrides(
  deployEnv: DeployEnvironment,
  chains: string[],
): Promise<ChainMap<Partial<ChainMetadata>>> {
  const projectId = 'abacus-labs-dev';

  const client = new SecretManagerServiceClient({
    projectId,
  });

  const chainMetadataOverrides: ChainMap<Partial<ChainMetadata>> = {};

  for (const chain of chains) {
    const secretName = `${deployEnv}-rpc-endpoints-${chain}`;
    const [secretVersion] = await client.accessSecretVersion({
      name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
    });
    const secretData = secretVersion.payload?.data;
    if (!secretData) {
      console.warn('Secret missing payload', secretName);
      continue;
    }

    // Handle both string and Uint8Array
    let dataStr: string;
    if (typeof secretData === 'string') {
      dataStr = secretData;
    } else {
      dataStr = new TextDecoder().decode(secretData);
    }

    const rpcUrls = JSON.parse(dataStr);
    chainMetadataOverrides[chain] = {
      rpcUrls: rpcUrls.map((rpcUrl: string) => ({
        http: rpcUrl,
      })),
    };
  }

  return chainMetadataOverrides;
}
