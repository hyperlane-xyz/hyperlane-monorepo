import { ChainMap, CoreConfig, objMap } from '@hyperlane-xyz/sdk';

import { multisigIsm } from './multisigIsm';
import { owners } from './owners';

export const core: ChainMap<CoreConfig> = objMap(owners, (chain, owner) => {
  return {
    owner,
    multisigIsm: multisigIsm[chain],
  };
});
