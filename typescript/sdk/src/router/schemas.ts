import { z } from 'zod';

import { ownableConfigSchema } from '../deploy/schemas.js';
import { ZHash } from '../index.js';
import { ismConfigSchema } from '../ism/schemas.js';

export const foreignDeploymentConfigSchema = z.object({
  foreignDeployment: z.string().optional(),
});

export const mailboxClientConfigSchema = z.object({
  mailbox: ZHash,
  hook: ZHash.optional(),
  interchainSecurityModule: ismConfigSchema.optional(),
});

export const routerConfigSchema = mailboxClientConfigSchema
  .merge(ownableConfigSchema)
  .merge(foreignDeploymentConfigSchema)
  .deepPartial();
