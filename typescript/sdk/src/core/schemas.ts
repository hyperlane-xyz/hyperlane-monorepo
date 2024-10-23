import { z } from 'zod';

import {
  OwnableConfigSchema,
  ProxyFactoryFactoriesSchema,
} from '../deploy/schemas.js';
import { HookConfigSchema } from '../hook/schemas.js';
import { IsmConfigSchema } from '../ism/schemas.js';
import { OwnableSchema } from '../schemas.js';

export const CoreConfigSchema = OwnableSchema.extend({
  defaultIsm: IsmConfigSchema,
  defaultHook: HookConfigSchema,
  requiredHook: HookConfigSchema,
  // These fields are set as optional because the old core config
  // did not have them and we want to maintain backward compatibility
  proxyAdmin: OwnableConfigSchema.optional(),
  interchainAccountRouter: OwnableConfigSchema.optional(),
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
