import {
  AbacusConnectionManager,
  Mailbox,
  MultisigValidatorManager,
} from '@abacus-network/core';
import type { types } from '@abacus-network/utils';

import { ChainName } from '../../types';
import type { CheckerViolation } from '../types';

export type ValidatorManagerConfig = {
  validators: Array<types.Address>;
  threshold: number;
};

export type CoreConfig = {
  validatorManager: ValidatorManagerConfig;
  owner?: types.Address;
  remove?: boolean;
};

export enum CoreViolationType {
  ValidatorManager = 'ValidatorManager',
  Mailbox = 'Mailbox',
  AbacusConnectionManager = 'AbacusConnectionManager',
}

export enum ValidatorManagerViolationType {
  EnrolledValidators = 'EnrolledValidators',
  Threshold = 'Threshold',
}

export enum AbacusConnectionManagerViolationType {
  EnrolledInboxes = 'EnrolledInboxes',
}

export enum MailboxViolationType {
  ValidatorManager = 'ValidatorManager',
}

export interface MailboxViolation extends CheckerViolation {
  type: CoreViolationType.Mailbox;
  contract: Mailbox;
  mailboxType: MailboxViolationType;
}

export interface MailboxValidatorManagerViolation extends MailboxViolation {
  actual: types.Address;
  expected: types.Address;
}

export interface ValidatorManagerViolation extends CheckerViolation {
  type: CoreViolationType.ValidatorManager;
  contract: MultisigValidatorManager;
  validatorManagerType: ValidatorManagerViolationType;
}

export interface EnrolledValidatorsViolation extends ValidatorManagerViolation {
  validatorManagerType: ValidatorManagerViolationType.EnrolledValidators;
  actual: Set<types.Address>;
  expected: Set<types.Address>;
}

export interface ThresholdViolation extends ValidatorManagerViolation {
  validatorManagerType: ValidatorManagerViolationType.Threshold;
  actual: number;
  expected: number;
}

export interface AbacusConnectionManagerViolation extends CheckerViolation {
  type: CoreViolationType.AbacusConnectionManager;
  contract: AbacusConnectionManager;
  abacusConnectionManagerType: AbacusConnectionManagerViolationType;
}

export interface EnrolledInboxesViolation
  extends AbacusConnectionManagerViolation {
  remote: ChainName;
  actual: Set<types.Address>;
  expected: Set<types.Address>;
}
