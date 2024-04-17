import { z } from 'zod';

import { ownableConfigSchema } from '../deploy/schemas.js';
import { ZHash } from '../index.js';

import { AggregationIsmConfig, IsmConfig, IsmType } from './types.js';

export const testIsmConfigSchema = z.object({
  type: z.literal(IsmType.TEST_ISM),
});

export const multisigConfigSchema = z.object({
  validators: z.array(ZHash),
  threshold: z.number(),
});

export const trustedRelayerIsmConfigSchema = z.object({
  type: z.literal(IsmType.TRUSTED_RELAYER),
  relayer: z.string(),
});

export const opStackIsmConfigSchema = z.object({
  type: z.literal(IsmType.OP_STACK),
  origin: z.string(),
  nativeBridge: z.string(),
});

export const pausableIsmConfigSchema = ownableConfigSchema.and(
  z.object({
    type: z.literal(IsmType.PAUSABLE),
    paused: z.boolean().optional(),
  }),
);

export const multisigIsmConfigSchema = multisigConfigSchema.and(
  z.object({
    type: z.union([
      z.literal(IsmType.MERKLE_ROOT_MULTISIG),
      z.literal(IsmType.MESSAGE_ID_MULTISIG),
    ]),
  }),
);

export const routingIsmConfigSchema = ownableConfigSchema.and(
  z.object({
    type: z.union([
      z.literal(IsmType.ROUTING),
      z.literal(IsmType.FALLBACK_ROUTING),
    ]),
    domains: z.record(z.string(), z.nativeEnum(IsmType)),
  }),
);

export const aggregationIsmConfigSchema: z.ZodSchema<AggregationIsmConfig> =
  z.lazy(() =>
    z.object({
      type: z.literal(IsmType.AGGREGATION),
      modules: z.array(ismConfigSchema),
      threshold: z.number(),
    }),
  );

export const ismConfigSchema: z.ZodSchema<IsmConfig> = z.lazy(() =>
  z.union([
    z.string(),
    testIsmConfigSchema,
    opStackIsmConfigSchema,
    pausableIsmConfigSchema,
    trustedRelayerIsmConfigSchema,
    multisigIsmConfigSchema,
    routingIsmConfigSchema,
    aggregationIsmConfigSchema,
  ]),
);
