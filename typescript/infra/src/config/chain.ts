import { Provider } from '@ethersproject/abstract-provider';
import { ethers } from 'ethers';

import { StaticCeloJsonRpcProvider } from '@abacus-network/celo-ethers-provider';
import { ChainName, RetryJsonRpcProvider } from '@abacus-network/sdk';

import { Contexts } from '../../config/contexts';
import { getSecretDeployerKey, getSecretRpcEndpoint } from '../agents';

import { DeployEnvironment } from './environment';

export async function fetchProvider(
  environment: DeployEnvironment,
  chainName: ChainName,
) {
  const rpc = await getSecretRpcEndpoint(environment, chainName);
  const celoChainNames = new Set(['alfajores', 'baklava', 'celo']);
  const provider = celoChainNames.has(chainName)
    ? new StaticCeloJsonRpcProvider(rpc)
    : new RetryJsonRpcProvider(new ethers.providers.JsonRpcProvider(rpc), {
        maxRequests: 6,
        baseRetryMs: 50,
      });
  return provider;
}

export async function fetchSigner(
  environment: DeployEnvironment,
  context: Contexts,
  chainName: ChainName,
  provider: Provider,
) {
  const key = await getSecretDeployerKey(environment, context, chainName);
  const wallet = new ethers.Wallet(key, provider);
  return wallet;
  // return new NonceManager(wallet);
}
