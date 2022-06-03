import { Provider } from '@ethersproject/abstract-provider';
import { NonceManager } from '@ethersproject/experimental';
import { StaticCeloJsonRpcProvider } from 'celo-ethers-provider';
import { ethers } from 'ethers';

import { ChainName, RetryJsonRpcProvider } from '@abacus-network/sdk';

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
        retryLimit: 2,
        interval: 250,
      });
  return provider;
}

export async function fetchSigner(
  environment: DeployEnvironment,
  chainName: ChainName,
  provider: Provider,
) {
  const key = await getSecretDeployerKey(environment, chainName);
  const wallet = new ethers.Wallet(key, provider);
  return new NonceManager(wallet);
}
