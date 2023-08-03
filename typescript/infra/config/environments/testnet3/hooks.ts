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

const chainNameFilter = new Set(['goerli', 'optimismgoerli']);
const filteredOwnersResult = filterByChains<string>(owners, chainNameFilter);

export const hooks: ChainMap<HookConfig> = objMap(
  filteredOwnersResult,
  (chain) => {
    if (chain === 'goerli') {
      const hookConfig: MessageHookConfig = {
        hookContractType: HookContractType.HOOK,
        nativeBridge: '0x5086d1eEF304eb5284A0f6720f79403b4e9bE294',
        remoteIsm: '0x4c5859f0f772848b2d91f1d83e2fe57935348029', // dummy, remoteISM should be deployed first
        destinationDomain: 420,
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
