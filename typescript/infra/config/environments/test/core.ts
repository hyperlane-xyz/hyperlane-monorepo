import { ChainMap, CoreConfig, ModuleType, objMap } from '@hyperlane-xyz/sdk';

import { multisigIsm } from './multisigIsm';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  return {
    owner,
    defaultIsm: {
      type: ModuleType.ROUTING,
      owner,
      domains: Object.fromEntries(
        Object.entries(multisigIsm).filter(([chain]) => chain !== local),
      ),
    },
  };
});
