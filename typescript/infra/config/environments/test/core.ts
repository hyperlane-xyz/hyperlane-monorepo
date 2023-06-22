import {
  AggregationIsmConfig,
  ChainMap,
  CoreConfig,
  ModuleType,
  objMap,
} from '@hyperlane-xyz/sdk';

import { merkleRootMultisig, messageIdMultisig } from './multisigIsm';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: AggregationIsmConfig = {
    type: ModuleType.AGGREGATION,
    modules: [merkleRootMultisig, messageIdMultisig],
    threshold: 1,
  };

  return {
    owner,
    defaultIsm,
  };
});
