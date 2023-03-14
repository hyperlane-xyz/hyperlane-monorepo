import { types } from '@hyperlane-xyz/utils';

import { CoreContracts } from '../core/contracts';
import { IgpContracts } from '../gas/contracts';
import { RouterConfig } from '../router/types';
import { ChainMap } from '../types';
import { objMap } from '../utils/objects';

export function createRouterConfigMap(
  owner: types.Address,
  coreContracts: ChainMap<CoreContracts>,
  igpContracts: ChainMap<IgpContracts>,
): ChainMap<RouterConfig> {
  return objMap(coreContracts, (chain, contracts) => {
    return {
      owner,
      mailbox: contracts.mailbox.address,
      interchainGasPaymaster:
        igpContracts[chain].interchainGasPaymaster.address,
    };
  });
}
