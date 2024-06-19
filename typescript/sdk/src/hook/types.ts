import { z } from 'zod';

import { OwnableConfig } from '../deploy/types.js';
import { ChainMap } from '../types.js';

import {
  HookConfigSchema,
  IgpSchema,
  MerkleTreeSchema,
  OpStackHookSchema,
  PausableHookSchema,
  ProtocolFeeSchema,
} from './schemas.js';

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
  CUSTOM = 'custom',
  MERKLE_TREE = 'merkleTreeHook',
  INTERCHAIN_GAS_PAYMASTER = 'interchainGasPaymaster',
  AGGREGATION = 'aggregationHook',
  PROTOCOL_FEE = 'protocolFee',
  OP_STACK = 'opStackHook',
  ROUTING = 'domainRoutingHook',
  FALLBACK_ROUTING = 'fallbackRoutingHook',
  PAUSABLE = 'pausableHook',
}

export type MerkleTreeHookConfig = z.infer<typeof MerkleTreeSchema>;
export type IgpHookConfig = z.infer<typeof IgpSchema>;
export type ProtocolFeeHookConfig = z.infer<typeof ProtocolFeeSchema>;
export type PausableHookConfig = z.infer<typeof PausableHookSchema>;
export type OpStackHookConfig = z.infer<typeof OpStackHookSchema>;

// explicitly typed to avoid zod circular dependency
export type AggregationHookConfig = {
  type: HookType.AGGREGATION;
  hooks: Array<HookConfig>;
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

export type HookConfig = z.infer<typeof HookConfigSchema>;

// Hook types that can be updated in-place
export const MUTABLE_HOOK_TYPE = [
  HookType.INTERCHAIN_GAS_PAYMASTER,
  HookType.PROTOCOL_FEE,
  HookType.ROUTING,
  HookType.FALLBACK_ROUTING,
  HookType.PAUSABLE,
];
