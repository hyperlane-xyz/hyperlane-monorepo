import { Provider } from '@ethersproject/abstract-provider';
import { NonceManager } from '@ethersproject/experimental';
import { StaticCeloJsonRpcProvider } from 'celo-ethers-provider';
import { ethers } from 'ethers';

import { ChainName } from '@abacus-network/sdk';

import { getSecretDeployerKey, getSecretRpcEndpoint } from '../agents';

import { ENVIRONMENTS_ENUM } from './environment';

export async function fetchProvider(
  environment: ENVIRONMENTS_ENUM,
  chainName: ChainName,
) {
  const rpc = await getSecretRpcEndpoint(environment, chainName);
  const celoChainNames = new Set(['alfajores', 'baklava', 'celo']);
  const provider = celoChainNames.has(chainName)
    ? new StaticCeloJsonRpcProvider(rpc)
    : new ethers.providers.JsonRpcProvider(rpc);
  return provider;
}

export async function fetchSigner(
  environment: ENVIRONMENTS_ENUM,
  chainName: ChainName,
  provider: Provider,
) {
  const key = await getSecretDeployerKey(environment, chainName);
  const wallet = new ethers.Wallet(key, provider);
  return new NonceManager(wallet);
}
