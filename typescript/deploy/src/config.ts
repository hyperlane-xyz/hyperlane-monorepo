import { ethers } from 'ethers';

import { ChainMap, ChainName } from '@abacus-network/sdk';

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

export type EnvironmentConfig<Networks extends ChainName> = ChainMap<
  Networks,
  TransactionConfig
>;
