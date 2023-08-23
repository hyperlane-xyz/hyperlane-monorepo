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

const chainNameFilter = new Set([Chains.ethereum, Chains.optimism]);
const filteredOwnersResult = filterByChains<string>(owners, chainNameFilter);

export const hooks: ChainMap<HookConfig> = objMap(
  filteredOwnersResult,
  (chain) => {
    if (chain === Chains.ethereum) {
      const hookConfig: MessageHookConfig = {
        hookContractType: HookContractType.HOOK,
        destination: Chains.optimism,
        nativeBridge: '0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1',
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
