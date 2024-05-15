import { z } from 'zod';

import { AccountConfigSchema } from '../middleware/account/schemas.js';

export const OwnerSchema = z.union([z.string(), AccountConfigSchema]);

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
