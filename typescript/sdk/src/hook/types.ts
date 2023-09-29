import { BigNumber } from 'ethers';

import type { Address } from '@hyperlane-xyz/utils';

import type { MultisigIsmConfig, RoutingIsmConfig } from '../ism/types';
import { ChainMap, ChainName } from '../types';

export enum InterceptorType {
  HOOK = 'hook',
  ISM = 'ism',
}

export type OpStackHookConfig = {
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

export type DomainRoutingHookConfig = {
  type: InterceptorType.HOOK;
  domains: ChainMap<HookConfig>;
};

export type RoutingInterceptorConfig = {
  hook: DomainRoutingHookConfig;
  ism: RoutingIsmConfig;
};

export type HookConfig =
  | OpStackHookConfig
  | MerkleRootHookConfig
  | DomainRoutingHookConfig;

export type InterceptorConfig =
  | MerkleRootInterceptorConfig
  | RoutingInterceptorConfig;
