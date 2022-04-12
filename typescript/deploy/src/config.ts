import { ethers } from 'ethers';
import { ChainName, domains, MultiProvider } from '@abacus-network/sdk';

export interface CheckerViolation {
  domain: number;
  type: string;
  expected: any;
  actual: any;
  data?: any;
}

export type TransactionConfig = {
  overrides: ethers.Overrides;
  supports1559?: boolean;
  // The number of confirmations considered reorg safe
  confirmations?: number;
};

export type Environment = {
  domains: ChainName[];
  transactionConfigs: Partial<Record<ChainName, TransactionConfig>>;
}

// this is currently a kludge to account for ethers issues
function fixOverrides(config: TransactionConfig): ethers.Overrides {
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

export const registerDomains = (
  multiProvider: MultiProvider,
  domainNames: ChainName[],
) => {
  domainNames.forEach((name) => {
    multiProvider.registerDomain(domains[name]);
  });
};

export const registerTransactionConfigs = (
  multiProvider: MultiProvider,
  configs: Partial<Record<ChainName, TransactionConfig>>,
) => {
  multiProvider.domainNames.forEach((name) => {
    const config = configs[name];
    if (!config) throw new Error(`Missing TransactionConfig for ${name}`);
    multiProvider.registerOverrides(name, fixOverrides(config));
    if (config.confirmations) {
      multiProvider.registerConfirmations(name, config.confirmations);
    }
  });
};

export const registerSigners = (
  multiProvider: MultiProvider,
  signers: Partial<Record<ChainName, ethers.Signer>>,
) => {
  multiProvider.domainNames.forEach((name) => {
    const signer = signers[name];
    if (!signer) throw new Error(`Missing signer for ${name}`);
    multiProvider.registerSigner(name, signer);
  });
};

export const registerSigner = (
  multiProvider: MultiProvider,
  signer: ethers.Signer,
) => {
  multiProvider.domainNames.forEach((name) => {
    multiProvider.registerSigner(name, signer);
  });
};

export const registerEnvironment = (
  multiProvider: MultiProvider,
  environment: Environment,
) => {
  registerDomains(multiProvider, environment.domains)
  registerTransactionConfigs(multiProvider, environment.transactionConfigs)
};

export const registerHardhatEnvironment = (
  multiProvider: MultiProvider,
  environment: Environment,
  signer: ethers.Signer,
) => {
  registerDomains(multiProvider, environment.domains)
  registerTransactionConfigs(multiProvider, environment.transactionConfigs)
  multiProvider.domainNames.forEach((name) => {
    multiProvider.registerConfirmations(name, 0);
  });
  registerSigner(multiProvider, signer)
};
