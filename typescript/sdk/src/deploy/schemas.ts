import { z } from 'zod';

export const OwnerSchema = z.string();

export const OwnableConfigSchema = z.object({
  owner: OwnerSchema,
});

export const ProxyFactoryFactoriesSchema = z.object({
  staticMerkleRootMultisigIsmFactory: z.string(),
  staticMessageIdMultisigIsmFactory: z.string(),
  staticAggregationIsmFactory: z.string(),
  staticAggregationHookFactory: z.string(),
  domainRoutingIsmFactory: z.string(),
});

export type ProxyFactoryFactoriesAddresses = z.infer<
  typeof ProxyFactoryFactoriesSchema
>;
