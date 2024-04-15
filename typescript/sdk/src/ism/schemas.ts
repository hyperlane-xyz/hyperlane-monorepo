import { z } from 'zod';

import { ownableConfigSchema } from '../deploy/schemas.js';

import {
  AggregationIsmConfig,
  IsmConfig,
  IsmType,
  ModuleType,
} from './types.js';

export const moduleTypeSchema = z.nativeEnum(ModuleType);

export const ismTypeSchema = z.nativeEnum(IsmType);

export const testIsmConfigSchema = z.object({
  type: z.literal(IsmType.TEST_ISM),
});

export const deployedIsmTypeSchema = z.object({});

const addressSchema = z.any();

const chainMapSchema = z.any();

export const multisigConfigSchema = z.object({
  validators: z.array(addressSchema),
  threshold: z.number(),
});

export const multisigIsmConfigSchema = multisigConfigSchema.and(
  z.object({
    type: z.union([
      z.literal(IsmType.MERKLE_ROOT_MULTISIG),
      z.literal(IsmType.MESSAGE_ID_MULTISIG),
    ]),
  }),
);

export const pausableIsmConfigSchema = ownableConfigSchema.and(
  z.object({
    type: z.literal(IsmType.PAUSABLE),
    paused: z.boolean().optional(),
  }),
);

export const routingIsmConfigSchema = ownableConfigSchema.and(
  z.object({
    type: z.union([
      z.literal(IsmType.ROUTING),
      z.literal(IsmType.FALLBACK_ROUTING),
    ]),
    domains: chainMapSchema,
  }),
);

export const opStackIsmConfigSchema = z.object({
  type: z.literal(IsmType.OP_STACK),
  origin: addressSchema,
  nativeBridge: addressSchema,
});

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
    addressSchema,
    routingIsmConfigSchema,
    multisigIsmConfigSchema,
    aggregationIsmConfigSchema,
    opStackIsmConfigSchema,
    testIsmConfigSchema,
    pausableIsmConfigSchema,
  ]),
);
