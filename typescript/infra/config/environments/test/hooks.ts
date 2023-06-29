import { ChainMap, objMap } from '@hyperlane-xyz/sdk';
import {
  HookConfig,
  MessageHookConfig,
  NativeType,
  NoMetadataIsmConfig,
} from '@hyperlane-xyz/sdk/dist/hook/types';

import { ownersForHooks } from './owners';

export const hooks: ChainMap<HookConfig> = objMap(ownersForHooks, (chain) => {
  if (chain === 'test1') {
    return {
      nativeType: NativeType.HOOK,
      nativeBridge: '0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1',
      remoteIsm: '0x4c5859f0f772848b2d91f1d83e2fe57935348029', // dummy
      destinationDomain: 10,
    } as MessageHookConfig;
  } else {
    return {
      nativeType: NativeType.ISM,
      nativeBridge: '0x4200000000000000000000000000000000000007',
    } as NoMetadataIsmConfig;
  }
});
