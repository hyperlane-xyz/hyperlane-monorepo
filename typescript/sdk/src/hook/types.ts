import { BigNumber } from 'ethers';

import type { Address } from '@hyperlane-xyz/utils';

import type { MultisigIsmConfig } from '../ism/types';
import { ChainName } from '../types';

export enum InterceptorType {
  HOOK = 'hook',
  ISM = 'ism',
}

export type OPStackHookConfig = {
  type: InterceptorType.HOOK;
  nativeBridge: Address;
  remoteIsm?: Address;
  destinationDomain: BigNumber;
  destination: ChainName;
};

export type MerkleRootHookConfig = {
  type: InterceptorType.HOOK;
};

export type MerkleRootInterceptorConfig = {
  hook: MerkleRootHookConfig;
  ism: MultisigIsmConfig;
};

export type OPStackInterceptorConfig = {
  hook?: OPStackHookConfig;
  ism?: NoMetadataIsmConfig;
};

export type HookConfig = OPStackHookConfig | MerkleRootHookConfig;

export type NoMetadataIsmConfig = {
  type: InterceptorType.ISM;
  origin: ChainName;
  nativeBridge: Address;
};

export type InterceptorConfig =
  | MerkleRootInterceptorConfig
  | OPStackInterceptorConfig;
