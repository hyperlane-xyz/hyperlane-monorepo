import type { Address } from '@hyperlane-xyz/utils';

import type { IsmConfig } from '../ism/types';
import { ChainName } from '../types';

export enum HookContractType {
  HOOK = 'hook',
  ISM = 'ism',
}

export type OpStackHookConfig = {
  hookContractType: HookContractType.HOOK;
  mailbox: Address;
  nativeBridge: Address;
  remoteIsm?: Address;
  destination: ChainName;
};

export type MerkleTreeHookConfig = {
  hookContractType: HookContractType.HOOK;
  mailbox: Address;
};

export type PostDispatchHookConfig = OpStackHookConfig | MerkleTreeHookConfig;

export type NoMetadataIsmConfig = {
  hookContractType: HookContractType.ISM;
  nativeBridge: Address;
};

export type InterceptorConfig = PostDispatchHookConfig | IsmConfig;
