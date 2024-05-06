import { z } from 'zod';

import {
  DomainRoutingIsmFactory__factory,
  StaticAggregationHookFactory__factory,
  StaticAggregationIsmFactory__factory,
  StaticMerkleRootMultisigIsmFactory__factory,
  StaticMessageIdMultisigIsmFactory__factory,
} from '@hyperlane-xyz/core';

import { AccountConfigSchema } from '../middleware/account/schemas.js';

export const OwnerSchema = z.union([z.string(), AccountConfigSchema]);

export const OwnableConfigSchema = z.object({
  owner: OwnerSchema,
});

export const ProxyFactoryFactoriesSchema = z.object({
  staticMerkleRootMultisigIsmFactory: z.instanceof(
    StaticMerkleRootMultisigIsmFactory__factory,
  ),
  staticMessageIdMultisigIsmFactory: z.instanceof(
    StaticMessageIdMultisigIsmFactory__factory,
  ),
  staticAggregationIsmFactory: z.instanceof(
    StaticAggregationIsmFactory__factory,
  ),
  staticAggregationHookFactory: z.instanceof(
    StaticAggregationHookFactory__factory,
  ),
  domainRoutingIsmFactory: z.instanceof(DomainRoutingIsmFactory__factory),
});
