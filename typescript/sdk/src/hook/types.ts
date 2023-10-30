import { BigNumber } from 'ethers';

import { Address } from '@hyperlane-xyz/utils';

import { IgpConfig } from '../gas/types';
import { ChainMap, ChainName } from '../types';

export enum HookType {
  MERKLE_TREE = 'merkleTreeHook',
  INTERCHAIN_GAS_PAYMASTER = 'interchainGasPaymaster',
  AGGREGATION = 'aggregationHook',
  PROTOCOL_FEE = 'protocolFee',
  OP_STACK = 'opStackHook',
  ROUTING = 'domainRoutingHook',
  FALLBACK_ROUTING = 'fallbackRoutingHook',
}

export type MerkleTreeHookConfig = {
  type: HookType.MERKLE_TREE;
};

export type AggregationHookConfig = {
  type: HookType.AGGREGATION;
  hooks: Array<HookConfig>;
};

export type IgpHookConfig = IgpConfig & {
  type: HookType.INTERCHAIN_GAS_PAYMASTER;
};

export type ProtocolFeeHookConfig = {
  type: HookType.PROTOCOL_FEE;
  maxProtocolFee: BigNumber;
  protocolFee: BigNumber;
  beneficiary: Address;
  owner: Address;
};

export type OpStackHookConfig = {
  type: HookType.OP_STACK;
  nativeBridge: Address;
  destinationChain: ChainName;
};

type RoutingHookConfig = {
  owner: Address;
  domains: ChainMap<HookConfig>;
};

export type DomainRoutingHookConfig = RoutingHookConfig & {
  type: HookType.ROUTING;
};

export type FallbackRoutingHookConfig = RoutingHookConfig & {
  type: HookType.FALLBACK_ROUTING;
  fallback: HookConfig;
};

export type HookConfig =
  | MerkleTreeHookConfig
  | AggregationHookConfig
  | IgpHookConfig
  | ProtocolFeeHookConfig
  | OpStackHookConfig
  | DomainRoutingHookConfig
  | FallbackRoutingHookConfig;
