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
  if (
    connectionType !== ConnectionType.Http &&
    connectionType !== ConnectionType.HttpQuorum
  ) {
    throw Error(`Unsupported connectionType: ${connectionType}`);
  }
  const quorum = connectionType === ConnectionType.HttpQuorum;
  const rpc = await getSecretRpcEndpoint(environment, chainName, quorum);
  if (quorum) {
    return new ethers.providers.FallbackProvider(
      (rpc as string[]).map((url) => providerBuilder(url, chainName)),
      1, // a single provider is "quorum", but failure will cause failover to the next provider
    );
  } else {
    return providerBuilder(rpc, chainName);
  }
}
