import { z } from 'zod';

import { ZHash } from '../metadata/customZodTypes.js';
import { RemoteRoutersSchema } from '../router/schemas.js';
import { DerivedOwnableSchema } from '../schemas.js';

export const RemoteIcaRouterConfigSchema = z.record(
  z.string(),
  z.object({
    address: ZHash,
    interchainSecurityModule: ZHash.optional(),
  }),
);

export const IcaRouterConfigSchema = z.object({
  owner: ZHash,
  proxyAdmin: z.object({
    address: ZHash.optional(),
    owner: ZHash,
  }),
  remoteIcaRouters: RemoteRoutersSchema,
});

export const DerivedRemoteIcaRouterConfigSchema = z.record(
  z.string(),
  z.object({
    address: ZHash,
    interchainSecurityModule: ZHash.optional().describe(
      'Optional ISM override to be used on the chain',
    ),
  }),
);

export const DerivedIcaRouterConfigSchema = DerivedOwnableSchema.merge(
  z
    .object({
      owner: ZHash,
      mailbox: ZHash,
      proxyAdmin: DerivedOwnableSchema,
      remoteIcaRouters: DerivedRemoteIcaRouterConfigSchema,
    })
    .strict(),
);
