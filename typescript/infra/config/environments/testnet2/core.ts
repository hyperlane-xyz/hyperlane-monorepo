import { ChainMap, CoreConfig, objMap } from '@hyperlane-xyz/sdk';

import { TestnetChains } from './chains';
import { validators } from './validators';

export const core: ChainMap<TestnetChains, CoreConfig> = objMap(
  validators,
  (_, validatorSet) => {
    return {
      validatorManager: {
        validators: validatorSet.validators.map((v) => v.address),
        threshold: validatorSet.threshold,
      },
    };
  },
);
