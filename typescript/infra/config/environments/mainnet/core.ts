import { CoreConfig } from '@abacus-network/deploy';
import { ChainMap } from '@abacus-network/sdk';

import { MainnetChains } from './chains';

export const core: ChainMap<MainnetChains, CoreConfig> = {
  celo: {
    validatorManager: {
      validators: [],
      threshold: 2,
    },
  },
  ethereum: {
    validatorManager: {
      validators: [],
      threshold: 2,
    },
  },
  avalanche: {
    validatorManager: {
      validators: [],
      threshold: 2,
    },
  },
  polygon: {
    validatorManager: {
      validators: [],
      threshold: 2,
    },
  },
  bsc: {
    validatorManager: {
      validators: [],
      threshold: 2,
    },
  },
  arbitrum: {
    validatorManager: {
      validators: [],
      threshold: 2,
    },
  },
  optimism: {
    validatorManager: {
      validators: [],
      threshold: 2,
    },
  },
};
