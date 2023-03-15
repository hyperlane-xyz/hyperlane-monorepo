import { FallbackProviderConfig } from '@ethersproject/providers';
import { ethers } from 'ethers';

import {
  AgentConnectionType,
  ChainName,
  RetryJsonRpcProvider,
} from '@hyperlane-xyz/sdk';

import { getSecretRpcEndpoint } from '../agents';

import { DeployEnvironment } from './environment';

const providerBuilder = (url: string, retry = true) => {
  const baseProvider = new ethers.providers.JsonRpcProvider(url);
  return retry
    ? new RetryJsonRpcProvider(baseProvider, {
        maxRequests: 6,
        baseRetryMs: 50,
      })
    : baseProvider;
};

export async function fetchProvider(
  environment: DeployEnvironment,
  chainName: ChainName,
  connectionType: AgentConnectionType = AgentConnectionType.Http,
): Promise<ethers.providers.Provider> {
  const single = connectionType === AgentConnectionType.Http;
  const rpcData = await getSecretRpcEndpoint(environment, chainName, !single);
  switch (connectionType) {
    case AgentConnectionType.Http: {
      return providerBuilder(rpcData);
    }
    case AgentConnectionType.HttpQuorum: {
      return new ethers.providers.FallbackProvider(
        (rpcData as string[]).map((url) => providerBuilder(url, false)), // disable retry for quorum
      );
    }
    case AgentConnectionType.HttpFallback: {
      return new ethers.providers.FallbackProvider(
        (rpcData as string[]).map((url, index) => {
          const fallbackProviderConfig: FallbackProviderConfig = {
            provider: providerBuilder(url),
            // Priority is used by the FallbackProvider to determine
            // how to order providers using ascending ordering.
            // When not specified, all providers have the same priority
            // and are ordered randomly for each RPC.
            priority: index,
          };
          console.log('fallbackProviderConfig', fallbackProviderConfig);
          return fallbackProviderConfig;
        }),
        1, // a single provider is "quorum", but failure will cause failover to the next provider
      );
    }
    default: {
      throw Error(`Unsupported connectionType: ${connectionType}`);
    }
  }
}
