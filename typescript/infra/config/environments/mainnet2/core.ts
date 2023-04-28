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
import { timelocks } from './timelocks';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const ownerOverrides = {
    proxyAdmin: timelocks[local],
  };

  const defaultIsm: RoutingIsmConfig = {
    type: ModuleType.ROUTING,
    owner,
    domains: Object.fromEntries(
      Object.entries(defaultMultisigIsmConfigs).filter(
        ([chain]) => chain !== local && chainNames.includes(chain),
      ),
    ),
  };
  return {
    owner,
    defaultIsm,
    ownerOverrides,
  };
});
