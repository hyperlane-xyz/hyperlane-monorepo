import { z } from 'zod';

import { ZHash } from '../metadata/customZodTypes.js';
import { OwnableSchema, PausableSchema } from '../schemas.js';

import { AggregationIsmConfig, IsmType, RoutingIsmConfig } from './types.js';

export const TestIsmConfigSchema = z.object({
  type: z.literal(IsmType.TEST_ISM),
});

export const MultisigConfigSchema = z.object({
  validators: z.array(ZHash),
  threshold: z.number(),
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
  TestIsmConfigSchema,
  OpStackIsmConfigSchema,
  PausableIsmConfigSchema,
  TrustedRelayerIsmConfigSchema,
  MultisigIsmConfigSchema,
  RoutingIsmConfigSchema,
  AggregationIsmConfigSchema,
  ArbL2ToL1IsmConfigSchema,
]);
