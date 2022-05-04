import { NonceManager } from '@ethersproject/experimental';
import { StaticCeloJsonRpcProvider } from 'celo-ethers-provider';
import { ethers } from 'ethers';

import { ChainName } from '@abacus-network/sdk';

import { getSecretDeployerKey, getSecretRpcEndpoint } from '../agents';

import { ENVIRONMENTS_ENUM } from './environment';

export async function fetchSigner<Networks extends ChainName>(
  environment: ENVIRONMENTS_ENUM,
  chainName: Networks,
): Promise<ethers.Signer> {
  const rpc = await getSecretRpcEndpoint(environment, chainName);
  const key = await getSecretDeployerKey(environment, chainName);
  // See https://github.com/ethers-io/ethers.js/issues/2107
  const celoChainNames = new Set(['alfajores', 'baklava', 'celo']);
  const provider = celoChainNames.has(chainName)
    ? new StaticCeloJsonRpcProvider(rpc)
    : new ethers.providers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  return new NonceManager(wallet);
}
