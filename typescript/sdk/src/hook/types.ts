import type { types } from '@hyperlane-xyz/utils';

import { ChainName } from '../types';

export enum HookContractType {
  HOOK = 'hook',
  ISM = 'ism',
}

export type MessageHookConfig = {
  hookContractType: HookContractType.HOOK;
  nativeBridge: types.Address;
  remoteIsm?: types.Address;
  destination: ChainName;
};

export type NoMetadataIsmConfig = {
  hookContractType: HookContractType.ISM;
  nativeBridge: types.Address;
};

export type HookConfig = MessageHookConfig | NoMetadataIsmConfig;
