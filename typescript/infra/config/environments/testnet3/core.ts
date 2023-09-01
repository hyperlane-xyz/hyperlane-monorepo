import {
  AggregationIsmConfig,
  ChainMap,
  CoreConfig,
  objMap,
} from '@hyperlane-xyz/sdk';

import { aggregationIsm } from '../../aggregationIsm';
import { Contexts } from '../../contexts';

import { igp } from './igp';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: AggregationIsmConfig = aggregationIsm(
    'testnet3',
    local,
    Contexts.Hyperlane,
  );
  return {
    ...igp[local],
    owner,
    defaultIsm,
  };
});
