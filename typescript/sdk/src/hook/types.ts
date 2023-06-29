import type { types } from '@hyperlane-xyz/utils';

export enum NativeType {
  HOOK = 'hook',
  ISM = 'ism',
}

export type MessageHookConfig = {
  nativeType: NativeType.HOOK;
  nativeBridge: types.Address;
  remoteIsm: types.Address;
  destinationDomain: number;
};

export type NoMetadataIsmConfig = {
  nativeType: NativeType.ISM;
  nativeBridge: types.Address;
};

export type HookConfig = MessageHookConfig | NoMetadataIsmConfig;
