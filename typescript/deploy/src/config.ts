import { ethers } from 'ethers';

import { ChainName, MultiProvider, domains } from '@abacus-network/sdk';

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
