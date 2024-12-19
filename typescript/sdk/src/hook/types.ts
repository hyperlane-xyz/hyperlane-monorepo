import { z } from 'zod';

import { StorageGasOracleConfigSchema } from '../gas/oracle/types.js';
import { ZHash } from '../metadata/customZodTypes.js';
import {
  ChainMap,
  OwnableConfig,
  OwnableSchema,
  PausableSchema,
} from '../types.js';

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

export const ProtocolFeeSchema = OwnableSchema.extend({
  type: z.literal(HookType.PROTOCOL_FEE),
  beneficiary: z.string(),
  maxProtocolFee: z.string(),
  protocolFee: z.string(),
});

export const MerkleTreeSchema = z.object({
  type: z.literal(HookType.MERKLE_TREE),
});

export const PausableHookSchema = PausableSchema.extend({
  type: z.literal(HookType.PAUSABLE),
});

export const OpStackHookSchema = OwnableSchema.extend({
  type: z.literal(HookType.OP_STACK),
  nativeBridge: z.string(),
  destinationChain: z.string(),
});

export const ArbL2ToL1HookSchema = z.object({
  type: z.literal(HookType.ARB_L2_TO_L1),
  arbSys: z
    .string()
    .describe(
      'precompile for sending messages to L1, interface here: https://github.com/OffchainLabs/nitro-contracts/blob/90037b996509312ef1addb3f9352457b8a99d6a6/src/precompiles/ArbSys.sol#L12',
    ),
  bridge: z
    .string()
    .optional()
    .describe(
      'address of the bridge contract on L1, optional only needed for non @arbitrum/sdk chains',
    ),
  destinationChain: z.string(),
  childHook: z.lazy((): z.ZodSchema => HookConfigSchema),
});

export const IgpSchema = OwnableSchema.extend({
  type: z.literal(HookType.INTERCHAIN_GAS_PAYMASTER),
  beneficiary: z.string(),
  oracleKey: z.string(),
  overhead: z.record(z.number()),
  oracleConfig: z.record(StorageGasOracleConfigSchema),
});

export const DomainRoutingHookConfigSchema: z.ZodSchema<DomainRoutingHookConfig> =
  z.lazy(() =>
    OwnableSchema.extend({
      type: z.literal(HookType.ROUTING),
      domains: z.record(HookConfigSchema),
    }),
  );

export const FallbackRoutingHookConfigSchema: z.ZodSchema<FallbackRoutingHookConfig> =
  z.lazy(() =>
    OwnableSchema.extend({
      type: z.literal(HookType.FALLBACK_ROUTING),
      domains: z.record(HookConfigSchema),
      fallback: HookConfigSchema,
    }),
  );

export const AggregationHookConfigSchema: z.ZodSchema<AggregationHookConfig> =
  z.lazy(() =>
    z.object({
      type: z.literal(HookType.AGGREGATION),
      hooks: z.array(HookConfigSchema),
    }),
  );

export const HookConfigSchema = z.union([
  ZHash,
  ProtocolFeeSchema,
  PausableHookSchema,
  OpStackHookSchema,
  MerkleTreeSchema,
  IgpSchema,
  DomainRoutingHookConfigSchema,
  FallbackRoutingHookConfigSchema,
  AggregationHookConfigSchema,
  ArbL2ToL1HookSchema,
]);
