import { AggregationIsmConfig, ChainMap, CoreConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from '../../aggregationIsm';
import { Contexts } from '../../contexts';

import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: AggregationIsmConfig = aggregationIsm(
    'testnet3',
    local,
    Contexts.Hyperlane,
  );
  return {
    owner,
    defaultIsm,
  };
});
