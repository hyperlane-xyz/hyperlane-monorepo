import { FallbackProviderConfig } from '@ethersproject/providers';
import { ethers } from 'ethers';

import { ChainName, providerBuilder } from '@hyperlane-xyz/sdk';

import { getSecretRpcEndpoint } from '../agents';

import { ConnectionType } from './agent';
import { DeployEnvironment } from './environment';

const defaultRetry = {
  maxRequests: 6,
  baseRetryMs: 50,
};

export async function fetchProvider(
  environment: DeployEnvironment,
  chainName: ChainName,
  connectionType: ConnectionType = ConnectionType.Http,
): Promise<ethers.providers.Provider> {
  const single = connectionType === ConnectionType.Http;
  const rpcData = await getSecretRpcEndpoint(environment, chainName, !single);
  switch (connectionType) {
    case ConnectionType.Http: {
      return providerBuilder({ http: rpcData, retry: defaultRetry });
    }
    case ConnectionType.HttpQuorum: {
      return new ethers.providers.FallbackProvider(
        (rpcData as string[]).map((url) => providerBuilder({ http: url })), // disable retry for quorum
      );
    }
    case ConnectionType.HttpFallback: {
      return new ethers.providers.FallbackProvider(
        (rpcData as string[]).map((url, index) => {
          const fallbackProviderConfig: FallbackProviderConfig = {
            provider: providerBuilder({ http: url, retry: defaultRetry }),
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
