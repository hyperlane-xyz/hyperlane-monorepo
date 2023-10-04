import { ChainMap, CoreConfig, HookType } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from '../../aggregationIsm';
import { Contexts } from '../../contexts';

import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm = aggregationIsm('mainnet2', local, Contexts.Hyperlane);

  let upgrade: CoreConfig['upgrade'];
  if (local === 'arbitrum') {
    upgrade = {
      timelock: {
        // 7 days in seconds
        delay: 7 * 24 * 60 * 60,
        roles: {
          proposer: owner,
          executor: owner,
        },
      },
    };
  }

  return {
    owner,
    upgrade,
    defaultIsm,
    defaultHook: {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
    },
    requiredHook: {
      type: HookType.MERKLE_TREE,
    },
  };
});
