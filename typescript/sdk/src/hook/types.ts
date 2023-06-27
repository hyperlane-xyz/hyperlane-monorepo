import type { types } from '@hyperlane-xyz/utils';

import { ChainName } from '../types';

export enum NativeType {
  HOOK = 'hook',
  ISM = 'ism',
}

export type MessageHookConfig = {
  chain: ChainName;
  nativeType: NativeType.HOOK;
  nativeBridge: types.Address;
  remoteIsm: types.Address;
  destinationDomain: number;
};

export type NoMetadataIsmConfig = {
  chain: ChainName;
  nativeType: NativeType.ISM;
  nativeBridge: types.Address;
};

export type HookConfig = MessageHookConfig | NoMetadataIsmConfig;
