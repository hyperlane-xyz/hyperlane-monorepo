import { FallbackProviderConfig } from '@ethersproject/providers';
import { ethers } from 'ethers';

import { StaticCeloJsonRpcProvider } from '@hyperlane-xyz/celo-ethers-provider';
import { ChainName, RetryJsonRpcProvider } from '@hyperlane-xyz/sdk';

import { getSecretRpcEndpoint } from '../agents';

import { ConnectionType } from './agent';
import { DeployEnvironment } from './environment';

const CELO_CHAIN_NAMES = new Set(['alfajores', 'baklava', 'celo']);

const providerBuilder = (url: string, chainName: ChainName, retry = true) => {
  // TODO: get StaticCeloJsonRpcProvider to be compatible with the RetryJsonRpcProvider.
  // For now, the two are incompatible, so even if retrying is requested for a Celo chain,
  // we don't use a RetryJsonRpcProvider.
  if (CELO_CHAIN_NAMES.has(chainName)) {
    return new StaticCeloJsonRpcProvider(url);
  }
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
  connectionType: ConnectionType = ConnectionType.Http,
): Promise<ethers.providers.Provider> {
  const single = connectionType === ConnectionType.Http;
  const rpcData = await getSecretRpcEndpoint(environment, chainName, !single);
  switch (connectionType) {
    case ConnectionType.Http: {
      return providerBuilder(rpcData, chainName);
    }
    case ConnectionType.HttpQuorum: {
      return new ethers.providers.FallbackProvider(
        (rpcData as string[]).map((url) =>
          providerBuilder(url, chainName, false),
        ), // disable retry for quorum
      );
    }
    case ConnectionType.HttpFallback: {
      return new ethers.providers.FallbackProvider(
        (rpcData as string[]).map((url, index) => {
          const fallbackProviderConfig: FallbackProviderConfig = {
            provider: providerBuilder(url, chainName),
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
