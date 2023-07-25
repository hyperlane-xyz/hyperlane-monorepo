import {
  ChainMap,
  CoreConfig,
  ModuleType,
  RoutingIsmConfig,
  defaultMultisigIsmConfigs,
  objMap,
} from '@hyperlane-xyz/sdk';

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
      upgrade: {
        timelock: {
          // 7 days in seconds
          delay: 7 * 24 * 60 * 60,
          roles: {
            proposer: owner,
            executor: owner,
          },
        },
      },
    };
  }

  return {
    owner,
    defaultIsm,
  };
});
