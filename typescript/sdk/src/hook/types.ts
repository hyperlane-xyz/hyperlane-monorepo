import type { Address } from '@hyperlane-xyz/utils';

import type { IsmConfig, MultisigIsmConfig } from '../ism/types';
import { ChainName } from '../types';

export enum HookContractType {
  HOOK = 'hook',
  ISM = 'ism',
}

export type OpStackHookConfig = {
  type: HookContractType.HOOK;
  mailbox: Address;
  nativeBridge: Address;
  remoteIsm?: Address;
  destination: ChainName;
};

export type MerkleTreeHookConfig = {
  type: HookContractType.HOOK;
  mailbox: Address;
};

export type MerkleRootInterceptorConfig =
  | MerkleTreeHookConfig
  | MultisigIsmConfig;

export type PostDispatchHookConfig =
  | OpStackHookConfig
  | MerkleRootInterceptorConfig;

export type NoMetadataIsmConfig = {
  type: HookContractType.ISM;
  nativeBridge: Address;
};

export type InterceptorConfig = PostDispatchHookConfig | IsmConfig;
