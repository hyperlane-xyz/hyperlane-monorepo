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

const RemoteRouterDomain = z.string();
const RemoteRouterRouter = z.string().startsWith('0x');
export const RemoteRoutersSchema = z.record(
  RemoteRouterDomain,
  RemoteRouterRouter,
);

const ProxyAdminConfigSchema = z.object({
  proxyAdmin: z.string().optional(),
});

export const RouterConfigSchema = MailboxClientConfigSchema.merge(
  ForeignDeploymentConfigSchema,
)
  .merge(
    z.object({
      remoteRouters: RemoteRoutersSchema.optional(),
    }),
  )
  .merge(ProxyAdminConfigSchema);

export const GasRouterConfigSchema = RouterConfigSchema.extend({
  gas: z.number().optional(),
});
