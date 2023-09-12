import { ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from '../../aggregationIsm';
import { Contexts } from '../../contexts';

import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm = aggregationIsm('testnet3', local, Contexts.Hyperlane);
  console.log('defaultIsm foobar', JSON.stringify(defaultIsm), owners);
  return {
    owner,
    defaultIsm,
  };
});
