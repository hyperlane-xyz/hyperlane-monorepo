import {
  ChainMap,
  CoreConfig,
  ModuleType,
  RoutingIsmConfig,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { aggregationIsm } from './aggregationIsm';
import { chainToValidator } from './multisigIsm';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: RoutingIsmConfig = {
    type: ModuleType.ROUTING,
    owner,
    domains: Object.fromEntries(
      Object.entries(chainToValidator)
        .filter(([chain, _]) => chain !== local)
        .map(([chain, validatorKey]) => [chain, aggregationIsm(validatorKey)]),
    ),
  };

  return {
    owner,
    defaultIsm,
  };
});
