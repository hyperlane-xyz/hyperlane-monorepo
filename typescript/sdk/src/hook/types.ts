import { Address } from '@hyperlane-xyz/utils';

import { OwnableConfig } from '../deploy/types.js';
import { IgpConfig } from '../gas/types.js';
import { ChainMap, ChainName } from '../types.js';

// As found in IPostDispatchHook.sol
export enum OnchainHookType {
  UNUSED,
  ROUTING,
  AGGREGATION,
  MERKLE_TREE,
  INTERCHAIN_GAS_PAYMASTER,
  FALLBACK_ROUTING,
  ID_AUTH_ISM,
  PAUSABLE,
  PROTOCOL_FEE,
  LAYER_ZERO_V1,
}

export enum HookType {
  MERKLE_TREE = 'merkleTreeHook',
  INTERCHAIN_GAS_PAYMASTER = 'interchainGasPaymaster',
  AGGREGATION = 'aggregationHook',
  PROTOCOL_FEE = 'protocolFee',
  OP_STACK = 'opStackHook',
  ROUTING = 'domainRoutingHook',
  FALLBACK_ROUTING = 'fallbackRoutingHook',
  PAUSABLE = 'pausableHook',
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

export type ProtocolFeeHookConfig = OwnableConfig & {
  type: HookType.PROTOCOL_FEE;
  maxProtocolFee: string;
  protocolFee: string;
  beneficiary: Address;
};

export type PausableHookConfig = OwnableConfig & {
  type: HookType.PAUSABLE;
};

export type OpStackHookConfig = OwnableConfig & {
  type: HookType.OP_STACK;
  nativeBridge: Address;
  destinationChain: ChainName;
};

export type RoutingHookConfig = OwnableConfig & {
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
  | FallbackRoutingHookConfig
  | PausableHookConfig;

export type HooksConfig = {
  required: HookConfig;
  default: HookConfig;
};
