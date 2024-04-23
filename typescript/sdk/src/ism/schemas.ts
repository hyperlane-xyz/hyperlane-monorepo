import { z } from 'zod';

import { OwnableConfigSchema } from '../deploy/schemas.js';
import { ZHash } from '../index.js';

import { AggregationIsmConfig, IsmConfig, IsmType } from './types.js';

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

export const PausableIsmConfigSchema = OwnableConfigSchema.and(
  z.object({
    type: z.literal(IsmType.PAUSABLE),
    paused: z.boolean().optional(),
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

export const RoutingIsmConfigSchema = OwnableConfigSchema.and(
  z.object({
    type: z.union([
      z.literal(IsmType.ROUTING),
      z.literal(IsmType.FALLBACK_ROUTING),
    ]),
    domains: z.record(z.string(), z.nativeEnum(IsmType)),
  }),
);

export const AggregationIsmConfigSchema: z.ZodSchema<AggregationIsmConfig> =
  z.lazy(() =>
    z
      .object({
        type: z.literal(IsmType.AGGREGATION),
        modules: z.array(IsmConfigSchema),
        threshold: z.number(),
      })
      .refine((data) => {
        if (data.threshold > data.modules.length) return false;

        return true;
      }),
  );

export const IsmConfigSchema: z.ZodSchema<IsmConfig> = z.lazy(() =>
  z.union([
    z.string(),
    TestIsmConfigSchema,
    OpStackIsmConfigSchema,
    PausableIsmConfigSchema,
    TrustedRelayerIsmConfigSchema,
    MultisigIsmConfigSchema,
    RoutingIsmConfigSchema,
    AggregationIsmConfigSchema,
  ]),
);
