import { z } from 'zod';

import { IsmConfigSchema } from '../ism/schemas.js';
import { ZHash } from '../metadata/customZodTypes.js';
import { OwnableSchema } from '../schemas.js';

export const MailboxClientConfigSchema = OwnableSchema.extend({
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
