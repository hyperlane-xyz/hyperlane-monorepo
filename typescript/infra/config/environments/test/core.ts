import {
  AggregationIsmConfig,
  ChainMap,
  CoreConfig,
  ModuleType,
  objMap,
} from '@hyperlane-xyz/sdk';

import { owners } from './owners';
import { routingIsm } from './routingIsm';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: AggregationIsmConfig = {
    type: ModuleType.AGGREGATION,
    modules: [routingIsm(local, owner)],
    threshold: 1,
  };

  return {
    owner,
    defaultIsm,
  };
});
