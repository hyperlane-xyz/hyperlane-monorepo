import { ethers } from 'ethers';
import { NonceManager } from '@ethersproject/experimental';
import { ChainName, domains, MultiProvider } from '@abacus-network/sdk';
import { getSecretDeployerKey, getSecretRpcEndpoint } from '../agents';

export type TransactionConfig = {
  overrides: ethers.Overrides;
  supports1559?: boolean;
  // The number of confirmations considered reorg safe
  confirmations?: number;
};

// this is currently a kludge to account for ethers issues
export function fixOverrides(config: TransactionConfig): ethers.Overrides {
  if (config.supports1559) {
    return {
      maxFeePerGas: config.overrides.maxFeePerGas,
      maxPriorityFeePerGas: config.overrides.maxPriorityFeePerGas,
      gasLimit: config.overrides.gasLimit,
    };
  } else {
    return {
      type: 0,
      gasPrice: config.overrides.gasPrice,
      gasLimit: config.overrides.gasLimit,
    };
  }
}

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

export const registerDomains = (
  domainNames: ChainName[],
  configs: Partial<Record<ChainName, TransactionConfig>>,
  multiProvider: MultiProvider,
) => {
  domainNames.forEach((name) => {
    multiProvider.registerDomain(domains[name]);
    const config = configs[name];
    if (!config) throw new Error(`Missing TransactionConfig for ${name}`);
    multiProvider.registerOverrides(name, fixOverrides(config));
    if (config.confirmations) {
      multiProvider.registerConfirmations(name, config.confirmations);
    }
  });
};
