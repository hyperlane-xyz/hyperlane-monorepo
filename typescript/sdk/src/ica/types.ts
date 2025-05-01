import { z } from 'zod';

import { ZHash } from '../metadata/customZodTypes.js';
import { RemoteRouterDomain, RemoteRouterRouter } from '../router/types.js';
import { DerivedOwnableSchema } from '../types.js';

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

export type IcaRouterConfig = z.infer<typeof IcaRouterConfigSchema>;

export const DerivedIcaRouterConfigSchema = DerivedOwnableSchema.merge(
  z
    .object({
      owner: ZHash,
      mailbox: ZHash,
      remoteIcaRouters: RemoteIcaRouterConfigSchema,
    })
    .strict(),
);

export type DerivedIcaRouterConfig = z.infer<
  typeof DerivedIcaRouterConfigSchema
>;
