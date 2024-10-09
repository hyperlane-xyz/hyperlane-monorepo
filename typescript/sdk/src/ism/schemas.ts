import { z } from 'zod';

import { ZHash } from '../metadata/customZodTypes.js';
import { OwnableSchema, PausableSchema } from '../schemas.js';

import { AggregationIsmConfig, IsmType, RoutingIsmConfig } from './types.js';

const ValidatorInfoSchema = z.object({
  signingAddress: ZHash,
  weight: z.number(),
});

const BaseIsmConfigSchema = z.object({
  // All the Ism types have an address but in some parts of the code
  // this value is not set because of the context (ex. warp route config before deployment).
  // When parsing an object zod's default behavior is to strip unknown fields meaning that
  // in some cases this field even if it was in the raw object was not included in the parsed value.
  // (ex. reading a warp route config after using warp read)
  address: z.string().optional(),
});

export const TestIsmConfigSchema = z.object({
  type: z.literal(IsmType.TEST_ISM),
});

export const MultisigConfigSchema = z.object({
  validators: z.array(ZHash),
  threshold: z.number(),
});

export const WeightedMultisigConfigSchema = z.object({
  validators: z.array(ValidatorInfoSchema),
  thresholdWeight: z.number(),
});

export const TrustedRelayerIsmConfigSchema = z.object({
  type: z.literal(IsmType.TRUSTED_RELAYER),
  relayer: z.string(),
});

export const OpStackIsmConfigSchema = z.object({
  type: z.literal(IsmType.OP_STACK),
  origin: z.string(),
  nativeBridge: z.string(),
});

export const ArbL2ToL1IsmConfigSchema = z.object({
  type: z.literal(IsmType.ARB_L2_TO_L1),
  bridge: z.string(),
});

export const PausableIsmConfigSchema = PausableSchema.and(
  z.object({
    type: z.literal(IsmType.PAUSABLE),
  }),
);

export const MultisigIsmConfigSchema = MultisigConfigSchema.and(
  z.object({
    type: z.union([
      z.literal(IsmType.MERKLE_ROOT_MULTISIG),
      z.literal(IsmType.MESSAGE_ID_MULTISIG),
    ]),
  }),
);

export const WeightedMultisigIsmConfigSchema = WeightedMultisigConfigSchema.and(
  z.object({
    type: z.union([
      z.literal(IsmType.WEIGHTED_MERKLE_ROOT_MULTISIG),
      z.literal(IsmType.WEIGHTED_MESSAGE_ID_MULTISIG),
    ]),
  }),
);

export const RoutingIsmConfigSchema: z.ZodSchema<RoutingIsmConfig> = z.lazy(
  () =>
    OwnableSchema.extend({
      type: z.union([
        z.literal(IsmType.ROUTING),
        z.literal(IsmType.FALLBACK_ROUTING),
      ]),
      domains: z.record(IsmConfigSchema),
    }),
);

export const AggregationIsmConfigSchema: z.ZodSchema<AggregationIsmConfig> = z
  .lazy(() =>
    z.object({
      type: z.literal(IsmType.AGGREGATION),
      modules: z.array(IsmConfigSchema),
      threshold: z.number(),
    }),
  )
  .refine((data) => data.threshold <= data.modules.length, {
    message: 'Threshold must be less than or equal to the number of modules',
  });

export const IsmConfigSchema = z.union([
  ZHash,
  BaseIsmConfigSchema.and(TestIsmConfigSchema),
  BaseIsmConfigSchema.and(OpStackIsmConfigSchema),
  BaseIsmConfigSchema.and(PausableIsmConfigSchema),
  BaseIsmConfigSchema.and(TrustedRelayerIsmConfigSchema),
  BaseIsmConfigSchema.and(MultisigIsmConfigSchema),
  BaseIsmConfigSchema.and(WeightedMultisigIsmConfigSchema),
  BaseIsmConfigSchema.and(RoutingIsmConfigSchema),
  BaseIsmConfigSchema.and(AggregationIsmConfigSchema),
  BaseIsmConfigSchema.and(ArbL2ToL1IsmConfigSchema),
]);
