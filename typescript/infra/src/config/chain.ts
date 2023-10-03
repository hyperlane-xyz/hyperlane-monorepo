import { providers } from 'ethers';

import {
  AgentConnectionType,
  ChainName,
  RetryJsonRpcProvider,
  RetryProviderOptions,
} from '@hyperlane-xyz/sdk';

import { getSecretRpcEndpoint } from '../agents';

import { DeployEnvironment } from './environment';

export const defaultRetry = {
  maxRequests: 6,
  baseRetryMs: 50,
};

function buildProvider(config?: {
  url?: string;
  network?: providers.Networkish;
  retry?: RetryProviderOptions;
}): providers.JsonRpcProvider {
  return config?.retry
    ? new RetryJsonRpcProvider(config.retry, config?.url, config?.network)
    : new providers.StaticJsonRpcProvider(config?.url, config?.network);
}

export async function fetchProvider(
  environment: DeployEnvironment,
  chainName: ChainName,
  connectionType: AgentConnectionType = AgentConnectionType.Http,
): Promise<providers.Provider> {
  const single = connectionType === AgentConnectionType.Http;
  const rpcData = await getSecretRpcEndpoint(environment, chainName, !single);
  switch (connectionType) {
    case AgentConnectionType.Http: {
      return buildProvider({ url: rpcData[0], retry: defaultRetry });
    }
    case AgentConnectionType.HttpQuorum: {
      return new providers.FallbackProvider(
        (rpcData as string[]).map((url) => buildProvider({ url })), // disable retry for quorum
      );
    }
    case AgentConnectionType.HttpFallback: {
      return new providers.FallbackProvider(
        (rpcData as string[]).map((url, index) => {
          const fallbackProviderConfig: providers.FallbackProviderConfig = {
            provider: buildProvider({ url, retry: defaultRetry }),
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
