import { z } from 'zod';

import { OwnableConfig } from '../deploy/types.js';
import { ChainMap } from '../types.js';

import {
  ArbL2ToL1HookSchema,
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
  RATE_LIMITED,
  ARB_L2_TO_L1,
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
  ARB_L2_TO_L1 = 'arbL2ToL1Hook',
}

export const HookTypeToContractNameMap: Record<
  Exclude<HookType, HookType.CUSTOM>,
  string
> = {
  [HookType.MERKLE_TREE]: 'merkleTreeHook',
  [HookType.INTERCHAIN_GAS_PAYMASTER]: 'interchainGasPaymaster',
  [HookType.AGGREGATION]: 'staticAggregationHook',
  [HookType.PROTOCOL_FEE]: 'protocolFee',
  [HookType.OP_STACK]: 'opStackHook',
  [HookType.ROUTING]: 'domainRoutingHook',
  [HookType.FALLBACK_ROUTING]: 'fallbackDomainRoutingHook',
  [HookType.PAUSABLE]: 'pausableHook',
  [HookType.ARB_L2_TO_L1]: 'arbL2ToL1Hook',
};

export type MerkleTreeHookConfig = z.infer<typeof MerkleTreeSchema>;
export type IgpHookConfig = z.infer<typeof IgpSchema>;
export type ProtocolFeeHookConfig = z.infer<typeof ProtocolFeeSchema>;
export type PausableHookConfig = z.infer<typeof PausableHookSchema>;
export type OpStackHookConfig = z.infer<typeof OpStackHookSchema>;
export type ArbL2ToL1HookConfig = z.infer<typeof ArbL2ToL1HookSchema>;

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
