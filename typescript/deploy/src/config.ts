import { ethers } from 'ethers';
import { ChainName } from '@abacus-network/sdk';

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
  signer?: ethers.Signer;
};

export type EnvironmentConfig = {
  domains: ChainName[];
  transactionConfigs: Partial<Record<ChainName, TransactionConfig>>;
};
