import { z } from 'zod';

import { ZHash } from '../metadata/customZodTypes.js';
import { RemoteRouterDomain, RemoteRouterRouter } from '../router/types.js';
import { DerivedOwnableSchema } from '../schemas.js';

export const RemoteIcaRouterConfigSchema = z.record(
  RemoteRouterDomain,
  RemoteRouterRouter.merge(
    z.object({
      interchainSecurityModule: ZHash.optional().describe(
        'Optional ISM override to be used on the chain',
      ),
    }),
  ),
);

export const IcaRouterConfigSchema = z.object({
  owner: ZHash,
  mailbox: ZHash,
  proxyAdmin: z.object({
    address: ZHash.optional(),
    owner: ZHash,
  }),
  remoteIcaRouters: RemoteIcaRouterConfigSchema.optional(),
});

export const DerivedIcaRouterConfigSchema = DerivedOwnableSchema.merge(
  z
    .object({
      owner: ZHash,
      mailbox: ZHash,
      proxyAdmin: DerivedOwnableSchema,
      remoteIcaRouters: RemoteIcaRouterConfigSchema,
    })
    .strict(),
);
