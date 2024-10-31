import { z } from 'zod';

import { ZHash } from '../metadata/customZodTypes.js';
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
  mailbox: ZHash,
  proxyAdmin: z.object({
    address: ZHash.optional(),
    owner: ZHash,
  }),
  remoteIcaRouters: RemoteIcaRouterConfigSchema,
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
