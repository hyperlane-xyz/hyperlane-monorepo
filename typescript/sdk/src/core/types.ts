import { z } from 'zod';

import type { Mailbox } from '@hyperlane-xyz/core';
import type { Address, ParsedMessage } from '@hyperlane-xyz/utils';

import type { UpgradeConfig } from '../deploy/proxy.js';
import type { CheckerViolation } from '../deploy/types.js';
import { ProxyFactoryFactoriesSchema } from '../deploy/types.js';
import { DerivedHookConfig, HookConfigSchema } from '../hook/types.js';
import {
  DerivedIcaRouterConfigSchema,
  IcaRouterConfigSchema,
} from '../ica/types.js';
import type { DerivedIsmConfig, IsmConfig } from '../ism/types.js';
import { IsmConfigSchema } from '../ism/types.js';
import type { ChainName } from '../types.js';
import { DeployedOwnableSchema, OwnableSchema } from '../types.js';

export const CoreConfigSchema = OwnableSchema.extend({
  defaultIsm: IsmConfigSchema,
  defaultHook: HookConfigSchema,
  requiredHook: HookConfigSchema,
  // These field are set as optional because the old core config
  // did not have them and we want to maintain backward compatibility
  proxyAdmin: DeployedOwnableSchema.optional(),
  interchainAccountRouter: IcaRouterConfigSchema.optional(),
});

export const DerivedCoreConfigSchema = CoreConfigSchema.merge(
  z.object({
    interchainAccountRouter: DerivedIcaRouterConfigSchema.optional(),
  }),
);

// Base core addresses without EVM-specific factories (protocol-agnostic)
export const BaseCoreAddressesSchema = z.object({
  mailbox: z.string(),
  validatorAnnounce: z.string(),
  proxyAdmin: z.string(),
  testRecipient: z.string(),
  timelockController: z.string().optional(),
  interchainAccountRouter: z.string(),
  merkleTreeHook: z.string().optional(),
  interchainGasPaymaster: z.string().optional(),
});

// EVM-specific core addresses with required proxy factory factories
export const EvmCoreAddressesSchema = BaseCoreAddressesSchema.merge(
  ProxyFactoryFactoriesSchema,
);

// Deployed core addresses with optional factories (for registry parsing and backward compatibility)
// This allows both EVM chains (with factories) and AltVM chains (without factories)
export const DeployedCoreAddressesSchema = BaseCoreAddressesSchema.merge(
  ProxyFactoryFactoriesSchema.partial(),
);

export type BaseCoreAddresses = z.infer<typeof BaseCoreAddressesSchema>;
export type EvmCoreAddresses = z.infer<typeof EvmCoreAddressesSchema>;
export type DeployedCoreAddresses = z.infer<typeof DeployedCoreAddressesSchema>;

export type CoreConfig = z.infer<typeof CoreConfigSchema> & {
  remove?: boolean;
  upgrade?: UpgradeConfig;
};

export type CoreConfigHookFieldKey = keyof Pick<
  CoreConfig,
  'requiredHook' | 'defaultHook'
>;

export type DerivedCoreConfig = z.infer<typeof DerivedCoreConfigSchema> & {
  defaultIsm: DerivedIsmConfig;
  requiredHook: DerivedHookConfig;
  defaultHook: DerivedHookConfig;
};

export enum CoreViolationType {
  Mailbox = 'Mailbox',
  ConnectionManager = 'ConnectionManager',
  ValidatorAnnounce = 'ValidatorAnnounce',
}

export enum MailboxViolationType {
  DefaultIsm = 'DefaultIsm',
  NotProxied = 'NotProxied',
}

export interface MailboxViolation extends CheckerViolation {
  type: CoreViolationType.Mailbox;
  subType: MailboxViolationType;
  contract: Mailbox;
}

export interface MailboxMultisigIsmViolation extends MailboxViolation {
  actual: Address;
  expected: IsmConfig;
}

export interface ValidatorAnnounceViolation extends CheckerViolation {
  type: CoreViolationType.ValidatorAnnounce;
  chain: ChainName;
  validator: Address;
  actual: boolean;
  expected: boolean;
}

export type DispatchedMessage = {
  id: string;
  message: string;
  parsed: ParsedMessage;
};
