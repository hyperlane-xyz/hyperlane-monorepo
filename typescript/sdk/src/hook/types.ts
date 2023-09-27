import { BigNumber } from 'ethers';

import type { Address } from '@hyperlane-xyz/utils';

import type { IsmConfig, MultisigIsmConfig } from '../ism/types';
import { ChainName } from '../types';

export enum HookContractType {
  HOOK = 'hook',
  ISM = 'ism',
}

export type OpStackHookConfig = {
  type: HookContractType.HOOK;
  nativeBridge: Address;
  remoteIsm?: Address;
  destinationDomain: BigNumber;
  destination: ChainName;
};

export type MerkleTreeHookConfig = {
  type: HookContractType.HOOK;
};

export type MerkleRootInterceptorConfig =
  | MerkleTreeHookConfig
  | MultisigIsmConfig;

export type OpStackInterceptorConfig = OpStackHookConfig | NoMetadataIsmConfig;

export type PostDispatchHookConfig =
  | OpStackHookConfig
  | MerkleRootInterceptorConfig;

export type NoMetadataIsmConfig = {
  type: HookContractType.ISM;
  origin: ChainName;
  nativeBridge: Address;
};

export type InterceptorConfig =
  | PostDispatchHookConfig
  | IsmConfig
  | NoMetadataIsmConfig;
