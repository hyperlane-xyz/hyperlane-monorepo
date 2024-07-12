import { z } from 'zod';

import { ProxyFactoryFactoriesSchema } from '../deploy/schemas.js';
import { HookConfigSchema } from '../hook/schemas.js';
import { IsmConfigSchema } from '../ism/schemas.js';
import { ZHash } from '../metadata/customZodTypes.js';
import { OwnableSchema } from '../schemas.js';

export const MailboxClientConfigSchema = OwnableSchema.extend({
  mailbox: ZHash,
  hook: HookConfigSchema.optional(),
  interchainSecurityModule: IsmConfigSchema.optional(),
  ismFactoryAddresses: ProxyFactoryFactoriesSchema.optional(),
});

export const ForeignDeploymentConfigSchema = z.object({
  foreignDeployment: z.string().optional(),
});

export const RemoteRouterSchema = z.object({
  domain: z.number(),
  router: z.string(),
});

export const RouterConfigSchema = MailboxClientConfigSchema.merge(
  ForeignDeploymentConfigSchema,
).merge(
  z.object({
    remoteRouters: z.array(RemoteRouterSchema).optional(),
  }),
);

export const GasRouterConfigSchema = RouterConfigSchema.extend({
  gas: z.number().optional(),
});
