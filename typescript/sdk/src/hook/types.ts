import type { types } from '@hyperlane-xyz/utils';

export enum HookContractType {
  HOOK = 'hook',
  ISM = 'ism',
}

export type MessageHookConfig = {
  hookContractType: HookContractType.HOOK;
  mailbox: types.Address;
  nativeBridge: types.Address;
  remoteIsm: types.Address;
  destinationDomain: number;
};

export type NoMetadataIsmConfig = {
  hookContractType: HookContractType.ISM;
  nativeBridge: types.Address;
};

export type HookConfig = MessageHookConfig | NoMetadataIsmConfig;
