import {
  AbacusConnectionManager,
  Mailbox,
  MultisigValidatorManager,
} from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

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
  ConnectionManager = 'ConnectionManager',
}

export enum ValidatorManagerViolationType {
  EnrolledValidators = 'EnrolledValidators',
  Threshold = 'Threshold',
}

export enum ConnectionManagerViolationType {
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
  remote: ChainName;
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

export interface ConnectionManagerViolation extends CheckerViolation {
  type: CoreViolationType.ConnectionManager;
  contract: AbacusConnectionManager;
  connectionManagerType: ConnectionManagerViolationType;
}

export interface EnrolledInboxesViolation extends ConnectionManagerViolation {
  remote: ChainName;
  actual: Set<types.Address>;
  expected: Set<types.Address>;
}
