import { z } from 'zod';

import { HookConfigSchema } from '../hook/schemas.js';
import { IsmConfigSchema } from '../ism/schemas.js';
import { ZHash } from '../metadata/customZodTypes.js';
import { DeployedOwnableSchema, OwnableSchema } from '../schemas.js';

export const MailboxClientConfigSchema = OwnableSchema.extend({
  mailbox: ZHash,
  hook: HookConfigSchema.optional(),
  interchainSecurityModule: IsmConfigSchema.optional(),
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

export const RouterConfigSchema = MailboxClientConfigSchema.merge(
  ForeignDeploymentConfigSchema,
).merge(
  z.object({
    remoteRouters: RemoteRoutersSchema.optional(),
    proxyAdmin: DeployedOwnableSchema.optional(),
  }),
);

const DestinationGasDomain = z.string();
const DestinationGasAmount = z.string(); // This must be a string type to match Ether's type
export const DestinationGasSchema = z.record(
  DestinationGasDomain,
  DestinationGasAmount,
);
export const GasRouterConfigSchema = RouterConfigSchema.extend({
  gas: z.number().optional(),
  destinationGas: DestinationGasSchema.optional(),
});
