import { ethers } from 'ethers';
import { NonceManager } from '@ethersproject/experimental';
import { ChainName } from '@abacus-network/sdk';
import { StaticCeloJsonRpcProvider } from 'celo-ethers-provider';
import { getSecretDeployerKey, getSecretRpcEndpoint } from '../agents';

export async function fetchSigner(
  environment: string,
  chainName: ChainName,
): Promise<ethers.Signer> {
  const rpc = await getSecretRpcEndpoint(environment, chainName);
  const key = await getSecretDeployerKey(environment, chainName);
  // See https://github.com/ethers-io/ethers.js/issues/2107
  const celoChainNames = new Set(['alfajores', 'baklava', 'celo']);
  const provider = celoChainNames.has(chainName) ?
    new StaticCeloJsonRpcProvider(rpc) :
    new ethers.providers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  return new NonceManager(wallet);
}
