import { ChainMap, CoreConfig, objMap } from '@hyperlane-xyz/sdk';

import { TestnetChains } from './chains';
import { validators } from './validators';

export const core: ChainMap<TestnetChains, CoreConfig> = objMap(
  validators,
  (_, validatorSet) => {
    return {
      owner: '0xfaD1C94469700833717Fa8a3017278BC1cA8031C',
      multisigIsm: {
        validators: validatorSet.validators.map((v) => v.address),
        threshold: validatorSet.threshold,
      },
    };
  },
);
