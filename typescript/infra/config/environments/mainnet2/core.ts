import { ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from '../../aggregationIsm';
import { Contexts } from '../../contexts';

import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm = aggregationIsm('mainnet2', local, Contexts.Hyperlane);

  if (local === 'arbitrum') {
    return {
      owner,
      defaultIsm,
      upgrade: {
        timelock: {
          // 7 days in seconds
          delay: 7 * 24 * 60 * 60,
          roles: {
            proposer: owner,
            executor: owner,
          },
        },
      },
    };
  }

  return {
    owner,
    defaultIsm,
  };
});
