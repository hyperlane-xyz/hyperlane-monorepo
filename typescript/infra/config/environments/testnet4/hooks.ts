import {
  ChainMap,
  Chains,
  HookConfig,
  HookContractType,
  MessageHookConfig,
  NoMetadataIsmConfig,
  filterByChains,
  objMap,
} from '@hyperlane-xyz/sdk';

import { owners } from './owners';

const chainNameFilter = new Set([Chains.goerli, Chains.optimismgoerli]);
const filteredOwnersResult = filterByChains<string>(owners, chainNameFilter);

export const hooks: ChainMap<HookConfig> = objMap(
  filteredOwnersResult,
  (chain) => {
    if (chain === Chains.goerli) {
      const hookConfig: MessageHookConfig = {
        hookContractType: HookContractType.HOOK,
        destination: Chains.optimismgoerli,
        nativeBridge: '0x5086d1eEF304eb5284A0f6720f79403b4e9bE294',
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
