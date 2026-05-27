import { z } from 'zod';

import type { Mailbox } from '@hyperlane-xyz/core';
import type { Address, ParsedMessage } from '@hyperlane-xyz/utils';

import type { UpgradeConfig } from '../deploy/proxy.js';
import type { CheckerViolation } from '../deploy/types.js';
import { ProxyFactoryFactoriesSchema } from '../deploy/types.js';
import type { DerivedHookConfig, HookConfig } from '../hook/types.js';
import { HookConfigSchema } from '../hook/types.js';
import { hookTreeContainsLegacyIgp } from '../hook/utils.js';
import {
  DerivedIcaRouterConfigSchema,
  IcaRouterConfigSchema,
} from '../ica/types.js';
import type { DerivedIsmConfig, IsmConfig } from '../ism/types.js';
import { IsmConfigSchema } from '../ism/types.js';
import type { ChainName } from '../types.js';
import { DeployedOwnableSchema, OwnableSchema } from '../types.js';
import { ismTreeContainsRateLimited } from '../utils/ism.js';

const CoreConfigBaseSchema = OwnableSchema.extend({
  defaultIsm: IsmConfigSchema,
  defaultHook: HookConfigSchema,
  requiredHook: HookConfigSchema,
  // These field are set as optional because the old core config
  // did not have them and we want to maintain backward compatibility
  proxyAdmin: DeployedOwnableSchema.optional(),
  interchainAccountRouter: IcaRouterConfigSchema.optional(),
  // Override canonical Permit2 address for QuotedCalls deployment
  permit2: z.string().optional(),
  // Set false for chains that should keep legacy core artifacts only.
  deployQuotedCalls: z.boolean().optional(),
  contractVersion: z.string().optional(),
});

const rejectRateLimitedDefaultIsm = (
  val: { defaultIsm: unknown },
  ctx: z.RefinementCtx,
) => {
  if (ismTreeContainsRateLimited(val.defaultIsm)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'RateLimitedIsm cannot be used as a core default ISM',
      path: ['defaultIsm'],
    });
  }
};

// QuotedCalls and the offchain-quoting IGP both require EIP-1153 transient
// storage, so they ship together on the same (non-legacy) chains. Reject the
// mismatch where a legacy IGP is configured but QuotedCalls is still set to
// deploy (deployQuotedCalls !== false).
const rejectQuotedCallsWithLegacyIgp = (
  val: {
    defaultHook: HookConfig;
    requiredHook: HookConfig;
    deployQuotedCalls?: boolean;
  },
  ctx: z.RefinementCtx,
) => {
  if (val.deployQuotedCalls === false) return;
  if (
    hookTreeContainsLegacyIgp(val.defaultHook) ||
    hookTreeContainsLegacyIgp(val.requiredHook)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'deployQuotedCalls must be false when a legacy IGP (igpVersion: legacy) is configured: QuotedCalls requires EIP-1153 transient storage and pairs with the new offchain-quoting IGP.',
      path: ['deployQuotedCalls'],
    });
  }
};

export const CoreConfigSchema = CoreConfigBaseSchema.superRefine((val, ctx) => {
  rejectRateLimitedDefaultIsm(val, ctx);
  rejectQuotedCallsWithLegacyIgp(val, ctx);
});

export const DerivedCoreConfigSchema = CoreConfigBaseSchema.merge(
  z.object({
    interchainAccountRouter: DerivedIcaRouterConfigSchema.optional(),
  }),
).superRefine((val, ctx) => {
  rejectRateLimitedDefaultIsm(val, ctx);
  rejectQuotedCallsWithLegacyIgp(val, ctx);
});

export const DeployedCoreAddressesSchema = ProxyFactoryFactoriesSchema.extend({
  mailbox: z.string(),
  validatorAnnounce: z.string(),
  proxyAdmin: z.string(),
  testRecipient: z.string(),
  timelockController: z.string().optional(),
  interchainAccountRouter: z.string(),
  quotedCalls: z.string().optional(),
  batchContractAddress: z.string().optional(),
  merkleTreeHook: z.string().optional(),
  interchainGasPaymaster: z.string().optional(),
});

export type DeployedCoreAddresses = z.infer<typeof DeployedCoreAddressesSchema>;

export type CoreConfig = z.infer<typeof CoreConfigSchema> & {
  remove?: boolean;
  upgrade?: UpgradeConfig;
};

export function shouldDeployQuotedCalls(
  config: Pick<CoreConfig, 'deployQuotedCalls'>,
): boolean {
  return config.deployQuotedCalls !== false;
}

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
