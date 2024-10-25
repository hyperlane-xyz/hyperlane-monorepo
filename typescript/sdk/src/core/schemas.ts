import { z } from 'zod';

import { ProxyFactoryFactoriesSchema } from '../deploy/schemas.js';
import { HookConfigSchema } from '../hook/schemas.js';
import { IsmConfigSchema } from '../ism/schemas.js';
import { DeployedOwnableSchema, OwnableSchema } from '../schemas.js';

export const CoreConfigSchema = OwnableSchema.extend({
  defaultIsm: IsmConfigSchema,
  defaultHook: HookConfigSchema,
  requiredHook: HookConfigSchema,
  // This field is set as optional because the old core config
  // did not have it and we want to maintain backward compatibility
  proxyAdmin: DeployedOwnableSchema.optional(),
});

export const DeployedCoreAddressesSchema = ProxyFactoryFactoriesSchema.extend({
  mailbox: z.string(),
  validatorAnnounce: z.string(),
  proxyAdmin: z.string(),
  testRecipient: z.string(),
  timelockController: z.string().optional(),
  interchainAccountRouter: z.string(),
  interchainAccountIsm: z.string(),
  merkleTreeHook: z.string().optional(),
  interchainGasPaymaster: z.string().optional(),
});

export type DeployedCoreAddresses = z.infer<typeof DeployedCoreAddressesSchema>;
