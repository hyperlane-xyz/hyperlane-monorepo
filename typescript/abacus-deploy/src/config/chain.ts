import { ethers } from 'ethers';
import { NonceManager } from '@ethersproject/experimental';
import { getSecretDeployerKey, getSecretRpcEndpoint } from '../agents';

export enum ChainName {
  // Mainnets
  CELO = 'celo',
  ETHEREUM = 'ethereum',
  AVALANCHE = 'avalanche',
  POLYGON = 'polygon',

  // Testnets
  ALFAJORES = 'alfajores',
  MUMBAI = 'mumbai',
  KOVAN = 'kovan',
  GOERLI = 'goerli',
  FUJI = 'fuji',
  RINKARBY = 'rinkarby',
  RINKEBY = 'rinkeby',
  ROPSTEN = 'ropsten',

  // Local
  LOCAL = 'local',
}

export type ChainConfig = {
  name: ChainName;
  domain: number;
  signer: ethers.Signer;
  overrides: ethers.Overrides;
  supports1559?: boolean;
  confirmations?: number;
};

export type ChainConfigWithoutSigner = Omit<ChainConfig, 'signer'>;

export async function fetchSigner(
  partial: ChainConfigWithoutSigner,
  environment: string,
  deployerKeySecretName: string,
): Promise<ChainConfig> {
  const rpc = await getSecretRpcEndpoint(environment, partial.name);
  const key = await getSecretDeployerKey(deployerKeySecretName);
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const signer = new NonceManager(wallet);
  return { ...partial, signer };
}

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
