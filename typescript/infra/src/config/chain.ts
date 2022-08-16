import { ethers } from 'ethers';

import { StaticCeloJsonRpcProvider } from '@abacus-network/celo-ethers-provider';
import { ChainName, RetryJsonRpcProvider } from '@abacus-network/sdk';

import { getSecretRpcEndpoint } from '../agents';

import { DeployEnvironment } from './environment';

const CELO_CHAIN_NAMES = new Set(['alfajores', 'baklava', 'celo']);

const providerBuilder = (url: string, chainName: ChainName, retry = true) => {
  const baseProvider = CELO_CHAIN_NAMES.has(chainName)
    ? new StaticCeloJsonRpcProvider(url)
    : new ethers.providers.JsonRpcProvider(url);
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
  quorum = false,
) {
  const rpc = await getSecretRpcEndpoint(environment, chainName, quorum);
  if (quorum) {
    return new ethers.providers.FallbackProvider(
      (rpc as string[]).map((url) => providerBuilder(url, chainName, false)), // disable retry for quorum
    );
  } else {
    return providerBuilder(rpc, chainName);
  }
}
