import { ChainName, ChainSubsetMap } from '@abacus-network/sdk';
import { ethers } from 'ethers';

export interface CheckerViolation {
  network: ChainName;
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
  signer?: ethers.Signer;
};

export type EnvironmentConfig<Networks extends ChainName> = {
  transactionConfigs: ChainSubsetMap<Networks, TransactionConfig>;
};
