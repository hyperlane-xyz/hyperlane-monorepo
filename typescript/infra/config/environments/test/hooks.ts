import {
  ChainMap,
  HookConfig,
  HookContractType,
  MessageHookConfig,
  NoMetadataIsmConfig,
  filterByChains,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { owners } from './owners';

const chainNameFilter = new Set(['test1', 'test2']);
const filteredOwnersResult = filterByChains<string>(owners, chainNameFilter);

export const hooks: ChainMap<HookConfig> = objMap(
  filteredOwnersResult,
  (chain) => {
    if (chain === 'test1') {
      const hookConfig: MessageHookConfig = {
        hookContractType: HookContractType.HOOK,
        nativeBridge: '0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1',
        remoteIsm: '0x4c5859f0f772848b2d91f1d83e2fe57935348029', // dummy, remoteISM should be deployed first
        destinationDomain: 10,
      };
      return hookConfig;
    } else {
      const ismConfig: NoMetadataIsmConfig = {
        hookContractType: HookContractType.ISM,
        nativeBridge: '0x4200000000000000000000000000000000000007',
      };
      return ismConfig;
    }
  },
);
