import {
  ChainMap,
  CoreConfig,
  defaultMultisigIsmConfigs,
  objMap,
} from '@hyperlane-xyz/sdk';

import { chainNames } from './chains';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  return {
    owner,
    multisigIsm: Object.fromEntries(
      Object.entries(defaultMultisigIsmConfigs).filter(
        ([chain]) => chain !== local && chainNames.includes(chain),
      ),
    ),
  };
});
