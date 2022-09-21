import { ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';

import { TestChains } from './chains';

export const core: ChainMap<TestChains, CoreConfig> = {
  // Hardhat accounts 1-4
  test1: {
    validatorManager: {
      validators: ['0x70997970c51812dc3a010c7d01b50e0d17dc79c8'],
      threshold: 1,
    },
  },
  test2: {
    validatorManager: {
      validators: ['0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'],
      threshold: 1,
    },
  },
  test3: {
    validatorManager: {
      validators: ['0x90f79bf6eb2c4f870365e785982e1f101e93b906'],
      threshold: 1,
    },
  },
};
