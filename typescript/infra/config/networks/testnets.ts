import { BigNumber } from 'ethers';

import { TransactionConfig } from '@abacus-network/deploy';
import { chainConnectionConfigs } from '@abacus-network/sdk';
import { ChainMap } from '@abacus-network/sdk';


const {
  kovan,
} = chainConnectionConfigs;

export const overriddenKovan: TransactionConfig = {
  ...kovan,
  overrides: {
    gasPrice: BigNumber.from(10_000_000_000),
    gasLimit: 15_000_000,
  },
};

const _configs = {
  ...chainConnectionConfigs,
  kovan: overriddenKovan,
};

export const configs: ChainMap<keyof typeof _configs, TransactionConfig> =
  _configs;
