import { z } from 'zod';

import { OwnableConfigSchema, PausableSchema } from '../deploy/schemas.js';

import {
  AggregationHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookType,
} from './types.js';

export const ProtocolFeeSchema = OwnableConfigSchema.extend({
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

export const OpStackHookSchema = OwnableConfigSchema.extend({
  type: z.literal(HookType.OP_STACK),
  nativeBridge: z.string(),
  destinationChain: z.string(),
});

export const IgpSchema = OwnableConfigSchema.extend({
  type: z.literal(HookType.INTERCHAIN_GAS_PAYMASTER),
  beneficiary: z.string(),
  oracleKey: z.string(),
  overhead: z.record(z.number()),
  // TODO: Fix this
  // oracleConfig: z.record(StorageGasOracleConfigSchema),
});

export const DomainRoutingHookConfigSchema: z.ZodSchema<DomainRoutingHookConfig> =
  z.lazy(() =>
    OwnableConfigSchema.extend({
      type: z.literal(HookType.ROUTING),
      domains: z.record(HookConfigSchema),
    }),
  );

export const FallbackRoutingHookConfigSchema: z.ZodSchema<FallbackRoutingHookConfig> =
  z.lazy(() =>
    OwnableConfigSchema.extend({
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
  ProtocolFeeSchema,
  PausableHookSchema,
  OpStackHookSchema,
  MerkleTreeSchema,
  IgpSchema,
  DomainRoutingHookConfigSchema,
  FallbackRoutingHookConfigSchema,
  AggregationHookConfigSchema,
]);
