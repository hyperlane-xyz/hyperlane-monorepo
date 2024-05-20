import { z } from 'zod';

import { OwnableConfigSchema } from '../deploy/schemas.js';
import { IsmConfigSchema } from '../ism/schemas.js';
import { ZHash } from '../metadata/customZodTypes.js';

export const MailboxClientConfigSchema = OwnableConfigSchema.extend({
  mailbox: ZHash,
  hook: ZHash.optional(),
  interchainSecurityModule: IsmConfigSchema.optional(),
});

export const ForeignDeploymentConfigSchema = z.object({
  foreignDeployment: z.string().optional(),
});

export const RouterConfigSchema = MailboxClientConfigSchema.merge(
  ForeignDeploymentConfigSchema,
);

export const GasRouterConfigSchema = RouterConfigSchema.extend({
  gas: z.number().optional(),
});
