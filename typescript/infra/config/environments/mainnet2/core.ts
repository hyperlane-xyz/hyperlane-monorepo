import { ChainMap, CoreConfig, objMap } from '@hyperlane-xyz/sdk';

import { MainnetChains } from './chains';
import { validators } from './validators';

const owners: ChainMap<MainnetChains, string> = {
  celo: '0x1DE69322B55AC7E0999F8e7738a1428C8b130E4d',
  ethereum: '0x12C5AB61Fe17dF9c65739DBa73dF294708f78d23',
  avalanche: '0xDF9B28B76877f1b1B4B8a11526Eb7D8D7C49f4f3',
  polygon: '0x0D195469f76146F6ae3De8fc887e0f0DFBA691e7',
  bsc: '0xA0d3dcB9d61Fba32cc02Ad63983e101b29E2f28a',
  arbitrum: '0xbA47E1b575980B7D1b1508cc48bE1Df4EE508111',
  optimism: '0xb523CFAf45AACF472859f8B793CB0BFDB16bD257',
  moonbeam: '0xF0cb1f968Df01fc789762fddBfA704AE0F952197',
  gnosis: '0x36b0AA0e7d04e7b825D7E409FEa3c9A3d57E4C22',
};

export const core: ChainMap<MainnetChains, CoreConfig> = objMap(
  validators,
  (chain, validatorSet) => {
    return {
      owner: owners[chain],
      multisigIsm: {
        validators: validatorSet.validators.map((v) => v.address),
        threshold: validatorSet.threshold,
      },
    };
  },
);
