import { types } from '@hyperlane-xyz/utils';

import { ChainMap } from '../types';
import { objMap } from '../utils/objects';

export function getChainToOwnerMap(
  configMap: ChainMap<any>,
  owner: types.Address,
): ChainMap<{ owner: string }> {
  return objMap(configMap, () => {
    return {
      owner,
    };
  });
}
