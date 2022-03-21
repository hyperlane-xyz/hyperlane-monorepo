import { ethers } from 'ethers';
import { NonceManager } from '@ethersproject/experimental';
import { ChainName } from '@abacus-network/sdk';
import { getSecretDeployerKey, getSecretRpcEndpoint } from '../agents';

export type TransactionConfig = {
  overrides: ethers.Overrides;
  supports1559?: boolean;
  // The number of confirmations considered reorg safe
  confirmations?: number;
};

export async function fetchSigner(
  environment: string,
  name: ChainName,
  deployerKeySecretName: string,
): Promise<ethers.Signer> {
  const rpc = await getSecretRpcEndpoint(environment, name);
  const key = await getSecretDeployerKey(deployerKeySecretName);
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  return new NonceManager(wallet);
}

/*
export function getChainsForEnvironment(
  partials: ChainConfigWithoutSigner[],
  environment: string,
  deployerKeySecretName: string,
) {
  return () =>
    Promise.all(
      partials.map((partial) =>
        fetchSigner(partial, environment, deployerKeySecretName),
      ),
    );
}
*/
