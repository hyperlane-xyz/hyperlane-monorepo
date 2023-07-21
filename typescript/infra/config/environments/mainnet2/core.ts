import {
  ChainMap,
  CoreConfig,
  ModuleType,
  RoutingIsmConfig,
  defaultMultisigIsmConfigs,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { chainNames } from './chains';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: RoutingIsmConfig = {
    type: ModuleType.ROUTING,
    owner,
    domains: Object.fromEntries(
      Object.entries(defaultMultisigIsmConfigs).filter(
        ([chain]) => chain !== local && chainNames.includes(chain),
      ),
    ),
  };

  if (local === 'arbitrum') {
    return {
      owner,
      defaultIsm,
      // 7 days in seconds
      upgradeTimelockDelay: 7 * 24 * 60 * 60,
    };
  }

  return {
    owner,
    defaultIsm,
  };
});
