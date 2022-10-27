import { Mailbox, MultisigModule } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types';
import type { CheckerViolation } from '../types';

export type MultisigModuleConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  multisigModule: MultisigModuleConfig;
  owner?: types.Address;
  remove?: boolean;
};

export enum CoreViolationType {
  MultisigModule = 'MultisigModule',
  Mailbox = 'Mailbox',
  ConnectionManager = 'ConnectionManager',
}

export enum MultisigModuleViolationType {
  EnrolledValidators = 'EnrolledValidators',
  Threshold = 'Threshold',
}

export enum MailboxViolationType {
  DefaultModule = 'DefaultModule',
}

export interface MailboxViolation extends CheckerViolation {
  type: CoreViolationType.Mailbox;
  contract: Mailbox;
  mailboxType: MailboxViolationType;
}

export interface MailboxMultisigModuleViolation extends MailboxViolation {
  actual: types.Address;
  expected: types.Address;
}

export interface MultisigModuleViolation extends CheckerViolation {
  type: CoreViolationType.MultisigModule;
  contract: MultisigModule;
  subType: MultisigModuleViolationType;
  remote: ChainName;
}

export interface EnrolledValidatorsViolation extends MultisigModuleViolation {
  validatorManagerType: MultisigModuleViolationType.EnrolledValidators;
  actual: Set<types.Address>;
  expected: Set<types.Address>;
}

export interface ThresholdViolation extends MultisigModuleViolation {
  validatorManagerType: MultisigModuleViolationType.Threshold;
  actual: number;
  expected: number;
}
