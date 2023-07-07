import { ChainMap, objMap } from '@hyperlane-xyz/sdk';
import {
  HookConfig,
  MessageHookConfig,
  NativeType,
  NoMetadataIsmConfig,
} from '@hyperlane-xyz/sdk/dist/hook/types';
import { types } from '@hyperlane-xyz/utils';

import { owners } from './owners';

const filteredOwners: ChainMap<types.Address> = Object.keys(owners).reduce(
  (local, chain) => {
    if (chain === 'goerli' || chain === 'optimismgoerli') {
      local[chain] = owners[chain];
    }
    return local;
  },
  {} as ChainMap<types.Address>,
);

export const hooks: ChainMap<HookConfig> = objMap(filteredOwners, (chain) => {
  if (chain === 'goerli') {
    return {
      nativeType: NativeType.HOOK,
      nativeBridge: '0x5086d1eEF304eb5284A0f6720f79403b4e9bE294',
      remoteIsm: '0x4c5859f0f772848b2d91f1d83e2fe57935348029', // dummy, remoteISM should be deployed first
      destinationDomain: 420,
    } as MessageHookConfig;
  } else {
    return {
      nativeType: NativeType.ISM,
      nativeBridge: '0x4200000000000000000000000000000000000007',
    } as NoMetadataIsmConfig;
  }
});
