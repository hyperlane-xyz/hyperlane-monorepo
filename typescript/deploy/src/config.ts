import { ethers } from 'ethers';

import { ChainMap, ChainName } from '@abacus-network/sdk';

export interface CheckerViolation {
  chain: ChainName;
  type: string;
  expected: any;
  actual: any;
  data?: any;
}

export type TransactionConfig = {
  overrides?: ethers.Overrides;
  // The number of confirmations considered reorg safe
  confirmations?: number;
  signer?: ethers.Signer;
  provider?: ethers.providers.Provider;
};

export type EnvironmentConfig<Chain extends ChainName> = ChainMap<
  Chain,
  TransactionConfig
>;
