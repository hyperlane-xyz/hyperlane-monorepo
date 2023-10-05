import { ChainMap, CoreConfig, HookType } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from '../../aggregationIsm';
import { Contexts } from '../../contexts';

import { igp } from './igp';
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
      type: HookType.AGGREGATION,
      hooks: [
        {
          type: HookType.MERKLE_TREE,
        },
        {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          ...igp[local],
        },
      ],
    },
    // TODO: configure fee hook
    requiredHook: {
      type: HookType.MERKLE_TREE,
    },
  };
});
