import { ChainMap, CoreConfig, HookType } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from '../../aggregationIsm';
import { Contexts } from '../../contexts';

import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm = aggregationIsm('testnet3', local, Contexts.Hyperlane);
  return {
    owner,
    defaultIsm,
    defaultHook: {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
    },
    requiredHook: {
      type: HookType.MERKLE_TREE,
    },
  };
});
