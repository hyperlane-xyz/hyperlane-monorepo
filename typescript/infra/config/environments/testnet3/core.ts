import {
  ChainMap,
  CoreConfig,
  ModuleType,
  RoutingIsmConfig,
  defaultMultisigIsmConfigs,
  objMap,
} from '@hyperlane-xyz/sdk';

import { aggregationIsm } from './aggregationIsm';
import { chainNames } from './chains';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: RoutingIsmConfig = {
    type: ModuleType.ROUTING,
    owner,
    domains: Object.fromEntries(
      Object.entries(defaultMultisigIsmConfigs)
        .filter(([chain]) => chain !== local && chainNames.includes(chain))
        .map(([chain, multisigIsmConfig]) => [
          chain,
          aggregationIsm(multisigIsmConfig),
        ]),
    ),
  };

  return {
    owner,
    defaultIsm,
  };
});
