import { Address } from '@hyperlane-xyz/utils';

import { OwnableConfig } from '../deploy/types';
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

export type OpStackHookConfig = {
  type: HookType.OP_STACK;
  nativeBridge: Address;
  destinationChain: ChainName;
};

type RoutingHookConfig = OwnableConfig & {
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
