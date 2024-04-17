import { z } from 'zod';

import { ownableConfigSchema } from '../deploy/schemas.js';
import { ZHash } from '../index.js';
import { ismConfigSchema } from '../ism/schemas.js';

import { ClientViolationType, RouterViolationType } from './types.js';

export const gasConfigSchema = z.object({
  gas: z.number(),
});

export const clientViolationTypeSchema = z.nativeEnum(ClientViolationType);

export const routerViolationTypeSchema = z.nativeEnum(RouterViolationType);

// TODO FIX LATER
const addressSchema = ZHash;

const hyperlaneFactoriesSchema = z.any();

const proxyAdminFactorySchema = z.any();

const timelockControllerFactorySchema = z.any();

export const routerAddressSchema = z.object({
  router: addressSchema,
});

export const foreignDeploymentConfigSchema = z.object({
  foreignDeployment: addressSchema.optional(),
});

export const proxiedFactoriesSchema = hyperlaneFactoriesSchema.and(
  z.object({
    proxyAdmin: proxyAdminFactorySchema,
    timelockController: timelockControllerFactorySchema,
  }),
);

export const mailboxClientConfigSchema = z.object({
  mailbox: ZHash,
  hook: ZHash.optional(),
  interchainSecurityModule: ismConfigSchema.optional(),
});

export const routerConfigSchema = mailboxClientConfigSchema
  .merge(ownableConfigSchema)
  .merge(foreignDeploymentConfigSchema)
  .deepPartial();
